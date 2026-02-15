import string
import random
import asyncio
from typing import Optional

from fastapi import WebSocket
from sqlalchemy.orm import Session

from models import Message


class CollaborationSession:
    """Represents an active collaboration session."""

    def __init__(self, code: str, chat_id: int, owner_id: int, workflow_data: Optional[str]):
        self.code = code
        self.chat_id = chat_id
        self.owner_id = owner_id
        self.workflow_data = workflow_data
        self.connections: dict[int, dict] = {}  # {user_id: {"ws": WebSocket, "username": str}}
        self.locked_nodes: dict[str, int] = {}  # {node_id: user_id}

    @property
    def users(self) -> list[dict]:
        return [
            {"id": uid, "username": info["username"]}
            for uid, info in self.connections.items()
        ]

    def is_full(self) -> bool:
        return len(self.connections) >= 3


class CollaborationManager:
    """Singleton manager for all active collaboration sessions."""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._sessions: dict[str, CollaborationSession] = {}  # {code: session}
            cls._instance._chat_sessions: dict[int, str] = {}  # {chat_id: code}
        return cls._instance

    def _generate_code(self) -> str:
        """Generate a unique 6-char alphanumeric code."""
        chars = string.ascii_uppercase + string.digits
        while True:
            code = "".join(random.choices(chars, k=6))
            if code not in self._sessions:
                return code

    def create_session(self, chat_id: int, owner_id: int, db: Session) -> str:
        """Create a new collaboration session for a chat. Returns the session code."""
        # Check if chat already has an active session
        if chat_id in self._chat_sessions:
            return self._chat_sessions[chat_id]

        # Get the latest workflow data from the chat
        last_workflow_msg = (
            db.query(Message)
            .filter(
                Message.chat_id == chat_id,
                Message.role == "assistant",
                Message.workflow_data.isnot(None),
            )
            .order_by(Message.created_at.desc())
            .first()
        )
        workflow_data = last_workflow_msg.workflow_data if last_workflow_msg else None

        code = self._generate_code()
        session = CollaborationSession(code, chat_id, owner_id, workflow_data)
        self._sessions[code] = session
        self._chat_sessions[chat_id] = code
        return code

    def get_session(self, code: str) -> Optional[CollaborationSession]:
        return self._sessions.get(code)

    async def join_session(
        self, code: str, user_id: int, username: str, ws: WebSocket
    ) -> Optional[CollaborationSession]:
        """Add a user to a session. Returns None if session not found or full."""
        session = self._sessions.get(code)
        if not session:
            return None
        if session.is_full() and user_id not in session.connections:
            return None

        session.connections[user_id] = {"ws": ws, "username": username}
        return session

    async def leave_session(self, code: str, user_id: int):
        """Remove a user from a session, release their locks, destroy if empty."""
        session = self._sessions.get(code)
        if not session:
            return

        # Release all locks held by this user
        nodes_to_unlock = [
            nid for nid, uid in session.locked_nodes.items() if uid == user_id
        ]
        for node_id in nodes_to_unlock:
            del session.locked_nodes[node_id]

        # Remove connection
        session.connections.pop(user_id, None)

        # Broadcast user left + lock releases
        username = "Unknown"
        await self.broadcast(
            code,
            {
                "type": "user_left",
                "user": {"id": user_id, "username": username},
                "unlocked_nodes": nodes_to_unlock,
            },
            exclude_user_id=user_id,
        )

        # Destroy session if empty
        if not session.connections:
            self._sessions.pop(code, None)
            self._chat_sessions.pop(session.chat_id, None)

    def lock_node(self, code: str, node_id: str, user_id: int) -> tuple[bool, Optional[int]]:
        """Try to lock a node. Returns (success, locked_by_user_id)."""
        session = self._sessions.get(code)
        if not session:
            return False, None

        current_holder = session.locked_nodes.get(node_id)
        if current_holder is None or current_holder == user_id:
            session.locked_nodes[node_id] = user_id
            return True, None
        return False, current_holder

    def unlock_node(self, code: str, node_id: str, user_id: int) -> bool:
        """Release a node lock. Only the holder can unlock."""
        session = self._sessions.get(code)
        if not session:
            return False

        if session.locked_nodes.get(node_id) == user_id:
            del session.locked_nodes[node_id]
            return True
        return False

    def update_workflow(self, code: str, workflow_data: str):
        """Update the session's workflow data."""
        session = self._sessions.get(code)
        if session:
            session.workflow_data = workflow_data

    async def broadcast(
        self, code: str, message: dict, exclude_user_id: Optional[int] = None
    ):
        """Send a JSON message to all connected users except the excluded one."""
        session = self._sessions.get(code)
        if not session:
            return

        disconnected = []
        for user_id, info in session.connections.items():
            if user_id == exclude_user_id:
                continue
            try:
                await info["ws"].send_json(message)
            except Exception:
                disconnected.append(user_id)

        # Clean up disconnected users
        for user_id in disconnected:
            await self.leave_session(code, user_id)


# Singleton instance
collaboration_manager = CollaborationManager()
