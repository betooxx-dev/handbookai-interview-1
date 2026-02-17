import string
import random
import asyncio
from typing import Optional

from fastapi import WebSocket
from sqlalchemy.orm import Session

from models import Message, ChatMember
from models.collaboration_session import CollaborationSession as CollaborationSessionModel


class ActiveSession:
    """Represents an active collaboration session's in-memory state (WebSocket connections)."""

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


class CollaborationManager:
    """Singleton manager for all active collaboration sessions."""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._sessions: dict[str, ActiveSession] = {}  # {code: session}
            cls._instance._chat_sessions: dict[int, str] = {}  # {chat_id: code}
        return cls._instance

    def _generate_code(self, db: Session) -> str:
        """Generate a unique 6-char alphanumeric code (unique across DB and memory)."""
        chars = string.ascii_uppercase + string.digits
        while True:
            code = "".join(random.choices(chars, k=6))
            if code not in self._sessions:
                # Also check DB uniqueness
                existing = db.query(CollaborationSessionModel).filter(
                    CollaborationSessionModel.code == code
                ).first()
                if not existing:
                    return code

    def create_session(self, chat_id: int, owner_id: int, db: Session) -> str:
        """Create a new collaboration session for a chat. Returns the session code."""
        # Check if chat already has an active session in DB
        existing_db_session = (
            db.query(CollaborationSessionModel)
            .filter(
                CollaborationSessionModel.chat_id == chat_id,
                CollaborationSessionModel.is_active == True,
            )
            .first()
        )
        if existing_db_session:
            # Ensure in-memory session exists too
            if existing_db_session.code not in self._sessions:
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
                session = ActiveSession(existing_db_session.code, chat_id, owner_id, workflow_data)
                self._sessions[existing_db_session.code] = session
                self._chat_sessions[chat_id] = existing_db_session.code
            return existing_db_session.code

        # Also check in-memory (fallback)
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

        code = self._generate_code(db)

        # Persist to DB
        db_session = CollaborationSessionModel(
            chat_id=chat_id,
            code=code,
            created_by=owner_id,
            is_active=True,
        )
        db.add(db_session)
        db.commit()

        # Create in-memory session
        session = ActiveSession(code, chat_id, owner_id, workflow_data)
        self._sessions[code] = session
        self._chat_sessions[chat_id] = code
        return code

    def get_session(self, code: str) -> Optional[ActiveSession]:
        return self._sessions.get(code)

    def get_session_by_chat_id(self, chat_id: int, db: Session) -> Optional[str]:
        """Get the active session code for a chat, checking DB."""
        # Check in-memory first
        if chat_id in self._chat_sessions:
            return self._chat_sessions[chat_id]

        # Check DB
        db_session = (
            db.query(CollaborationSessionModel)
            .filter(
                CollaborationSessionModel.chat_id == chat_id,
                CollaborationSessionModel.is_active == True,
            )
            .first()
        )
        if db_session:
            return db_session.code
        return None

    async def join_session(
        self, code: str, user_id: int, username: str, ws: WebSocket, db: Session
    ) -> tuple[Optional[ActiveSession], bool]:
        """Add a user to a session. Returns (session, is_new_member). Session is None if not found or full."""
        is_new_member = False

        # Look up session in DB if not in memory
        if code not in self._sessions:
            db_session = (
                db.query(CollaborationSessionModel)
                .filter(
                    CollaborationSessionModel.code == code,
                    CollaborationSessionModel.is_active == True,
                )
                .first()
            )
            if not db_session:
                return None, False

            # Reconstruct in-memory session
            last_workflow_msg = (
                db.query(Message)
                .filter(
                    Message.chat_id == db_session.chat_id,
                    Message.role == "assistant",
                    Message.workflow_data.isnot(None),
                )
                .order_by(Message.created_at.desc())
                .first()
            )
            workflow_data = last_workflow_msg.workflow_data if last_workflow_msg else None
            session = ActiveSession(code, db_session.chat_id, db_session.created_by, workflow_data)
            self._sessions[code] = session
            self._chat_sessions[db_session.chat_id] = code

        session = self._sessions[code]

        # Check member count in DB (limit is 3)
        member_count = (
            db.query(ChatMember)
            .filter(ChatMember.chat_id == session.chat_id)
            .count()
        )

        # If user is already a member, just connect
        existing_member = (
            db.query(ChatMember)
            .filter(ChatMember.chat_id == session.chat_id, ChatMember.user_id == user_id)
            .first()
        )

        if not existing_member:
            if member_count >= 3:
                return None, False
            # Add as collaborator in DB
            new_member = ChatMember(
                chat_id=session.chat_id,
                user_id=user_id,
                role="collaborator",
            )
            db.add(new_member)
            db.commit()
            is_new_member = True

        session.connections[user_id] = {"ws": ws, "username": username}
        return session, is_new_member

    async def leave_session(self, code: str, user_id: int):
        """Remove a user's WebSocket connection from a session. Do NOT destroy the session."""
        session = self._sessions.get(code)
        if not session:
            return

        # Release all locks held by this user
        nodes_to_unlock = [
            nid for nid, uid in session.locked_nodes.items() if uid == user_id
        ]
        for node_id in nodes_to_unlock:
            del session.locked_nodes[node_id]

        # Get username before removing
        user_info = session.connections.get(user_id, {})
        username = user_info.get("username", "Unknown")

        # Remove WebSocket connection
        session.connections.pop(user_id, None)

        # Broadcast user left + lock releases
        await self.broadcast(
            code,
            {
                "type": "user_left",
                "user": {"id": user_id, "username": username},
                "unlocked_nodes": nodes_to_unlock,
            },
            exclude_user_id=user_id,
        )

        # Clean up in-memory session if empty (but keep DB session active)
        if not session.connections:
            self._sessions.pop(code, None)
            self._chat_sessions.pop(session.chat_id, None)

    async def kick_user(self, code: str, user_id: int):
        """Kick a user: send kicked message, close their WebSocket, and clean up."""
        session = self._sessions.get(code)
        if not session:
            return

        user_info = session.connections.get(user_id)
        if not user_info:
            return

        # Send kicked message to the user
        try:
            await user_info["ws"].send_json({"type": "kicked"})
            await user_info["ws"].close()
        except Exception:
            pass

        # Clean up their connection and locks
        await self.leave_session(code, user_id)

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

    async def broadcast_all(self, code: str, message: dict):
        """Send a JSON message to ALL connected users (including the sender)."""
        session = self._sessions.get(code)
        if not session:
            return

        disconnected = []
        for user_id, info in session.connections.items():
            try:
                await info["ws"].send_json(message)
            except Exception:
                disconnected.append(user_id)

        for user_id in disconnected:
            await self.leave_session(code, user_id)

    def lock_nodes_for_ai(self, code: str, node_ids: list[str], user_id: int) -> list[str]:
        """Lock multiple nodes for AI streaming. Returns the list of successfully locked node IDs."""
        session = self._sessions.get(code)
        if not session:
            return []

        locked = []
        for node_id in node_ids:
            current_holder = session.locked_nodes.get(node_id)
            if current_holder is None or current_holder == user_id:
                session.locked_nodes[node_id] = user_id
                locked.append(node_id)
        return locked

    def unlock_nodes_for_ai(self, code: str, node_ids: list[str], user_id: int) -> list[str]:
        """Unlock multiple nodes after AI streaming. Returns the list of unlocked node IDs."""
        session = self._sessions.get(code)
        if not session:
            return []

        unlocked = []
        for node_id in node_ids:
            if session.locked_nodes.get(node_id) == user_id:
                del session.locked_nodes[node_id]
                unlocked.append(node_id)
        return unlocked

    def get_other_users_locked_nodes(self, code: str, user_id: int) -> dict[str, int]:
        """Get a dict of node_id -> user_id for nodes locked by users OTHER than user_id."""
        session = self._sessions.get(code)
        if not session:
            return {}
        return {
            nid: uid for nid, uid in session.locked_nodes.items()
            if uid != user_id
        }


# Singleton instance
collaboration_manager = CollaborationManager()
