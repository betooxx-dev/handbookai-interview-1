import json

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, Query, HTTPException
from jose import jwt, JWTError
from sqlalchemy.orm import Session

from config import settings
from database import get_db
from models import User, ChatMember
from services import AuthService
from services.collaboration_manager import collaboration_manager
from services.workflow_service import WorkflowService

router = APIRouter(tags=["Collaboration"])


@router.post("/chats/{chat_id}/collaborate")
def create_collaboration_session(
    chat_id: int,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    """Create a collaboration session for a chat. Returns the join code."""
    from services.chat_service import ChatService
    ChatService.get_chat(chat_id, current_user.id, db)

    code = collaboration_manager.create_session(chat_id, current_user.id, db)
    return {"code": code, "chat_id": chat_id}


@router.get("/chats/{chat_id}/collaboration")
def get_collaboration_session(
    chat_id: int,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db),
):
    """Get the active collaboration session code for a chat, if any."""
    membership = (
        db.query(ChatMember)
        .filter(ChatMember.chat_id == chat_id, ChatMember.user_id == current_user.id)
        .first()
    )
    if not membership:
        raise HTTPException(status_code=404, detail="Chat not found")

    code = collaboration_manager.get_session_by_chat_id(chat_id, db)
    if not code:
        return {"code": None, "chat_id": chat_id}
    return {"code": code, "chat_id": chat_id}


def _authenticate_ws_token(token: str, db: Session) -> User | None:
    """Validate a JWT token for WebSocket connections."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            return None
    except JWTError:
        return None

    user = db.query(User).filter(User.username == username).first()
    return user


@router.websocket("/ws/collaborate/{code}")
async def collaborate_websocket(
    websocket: WebSocket,
    code: str,
    token: str = Query(...),
    db: Session = Depends(get_db),
):
    """WebSocket endpoint for real-time collaboration."""
    # Authenticate
    user = _authenticate_ws_token(token, db)
    if not user:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    # Join session (now also handles DB membership)
    session, is_new_member = await collaboration_manager.join_session(code, user.id, user.username, websocket, db)
    if not session:
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": "Session not found or full (max 3 users)"})
        await websocket.close()
        return

    await websocket.accept()

    # Send initial state
    await websocket.send_json({
        "type": "session_state",
        "chat_id": session.chat_id,
        "workflow_data": session.workflow_data,
        "users": session.users,
        "locked_nodes": {
            nid: {"id": uid, "username": session.connections.get(uid, {}).get("username", "Unknown")}
            for nid, uid in session.locked_nodes.items()
        },
    })

    # Notify others
    await collaboration_manager.broadcast(
        code,
        {"type": "user_joined", "user": {"id": user.id, "username": user.username}},
        exclude_user_id=user.id,
    )

    # Notify all users that a new member was added to the chat
    if is_new_member:
        await collaboration_manager.broadcast(
            code,
            {
                "type": "member_added",
                "chat_id": session.chat_id,
                "user": {"id": user.id, "username": user.username},
            },
        )

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "workflow_update":
                workflow_data = data.get("workflow_data")
                if workflow_data:
                    collaboration_manager.update_workflow(code, workflow_data)

                    # Persist to DB: update the latest workflow message
                    from models import Message
                    last_msg = (
                        db.query(Message)
                        .filter(
                            Message.chat_id == session.chat_id,
                            Message.role == "assistant",
                            Message.workflow_data.isnot(None),
                        )
                        .order_by(Message.created_at.desc())
                        .first()
                    )
                    if last_msg:
                        last_msg.workflow_data = workflow_data
                        db.commit()

                    await collaboration_manager.broadcast(
                        code,
                        {
                            "type": "workflow_update",
                            "workflow_data": workflow_data,
                            "from_user": {"id": user.id, "username": user.username},
                        },
                        exclude_user_id=user.id,
                    )

            elif msg_type == "node_lock":
                node_id = data.get("node_id")
                if node_id:
                    success, locked_by = collaboration_manager.lock_node(code, node_id, user.id)
                    if success:
                        await collaboration_manager.broadcast(
                            code,
                            {
                                "type": "node_lock",
                                "node_id": node_id,
                                "user": {"id": user.id, "username": user.username},
                            },
                            exclude_user_id=user.id,
                        )
                    else:
                        holder = session.connections.get(locked_by, {})
                        await websocket.send_json({
                            "type": "node_lock_denied",
                            "node_id": node_id,
                            "locked_by": {
                                "id": locked_by,
                                "username": holder.get("username", "Unknown"),
                            },
                        })

            elif msg_type == "node_unlock":
                node_id = data.get("node_id")
                if node_id and collaboration_manager.unlock_node(code, node_id, user.id):
                    await collaboration_manager.broadcast(
                        code,
                        {"type": "node_unlock", "node_id": node_id},
                        exclude_user_id=user.id,
                    )

            elif msg_type == "typing":
                # Broadcast typing indicator to other users
                await collaboration_manager.broadcast(
                    code,
                    {
                        "type": "typing",
                        "user": {"id": user.id, "username": user.username},
                    },
                    exclude_user_id=user.id,
                )

            elif msg_type == "chat_message":
                content = data.get("content", "").strip()
                if content:
                    try:
                        # Broadcast typing indicator for AI
                        await collaboration_manager.broadcast(
                            code,
                            {
                                "type": "typing",
                                "user": {"id": user.id, "username": user.username},
                            },
                            exclude_user_id=user.id,
                        )

                        # Capture title before AI call to detect changes
                        from models import Chat as ChatModel
                        chat_obj = db.query(ChatModel).filter(ChatModel.id == session.chat_id).first()
                        old_title = chat_obj.title if chat_obj else None

                        ai_message = WorkflowService.create_message_with_ai(
                            session.chat_id, content, user.id, db
                        )

                        # Find the user message that was just created (different ID from ai_message)
                        from models import Message
                        user_msg = (
                            db.query(Message)
                            .filter(
                                Message.chat_id == session.chat_id,
                                Message.role == "user",
                                Message.user_id == user.id,
                            )
                            .order_by(Message.created_at.desc())
                            .first()
                        )

                        # Update session workflow if AI generated one
                        if ai_message.workflow_data:
                            collaboration_manager.update_workflow(code, ai_message.workflow_data)

                        # Broadcast the user message to others (with correct user_msg ID)
                        await collaboration_manager.broadcast(
                            code,
                            {
                                "type": "new_message",
                                "message": {
                                    "id": user_msg.id if user_msg else ai_message.id - 1,
                                    "chat_id": session.chat_id,
                                    "user_id": user.id,
                                    "role": "user",
                                    "content": content,
                                    "username": user.username,
                                },
                            },
                            exclude_user_id=user.id,
                        )

                        # Broadcast AI response to ALL (including sender)
                        await collaboration_manager.broadcast(
                            code,
                            {
                                "type": "ai_response",
                                "message": {
                                    "id": ai_message.id,
                                    "chat_id": session.chat_id,
                                    "role": "assistant",
                                    "content": ai_message.content,
                                    "workflow_data": ai_message.workflow_data,
                                },
                            },
                        )

                        # Broadcast typing_done to unblock all inputs
                        await collaboration_manager.broadcast(
                            code,
                            {"type": "typing_done"},
                        )

                        # Check if title changed and broadcast update
                        db.refresh(chat_obj)
                        if chat_obj and chat_obj.title != old_title:
                            await collaboration_manager.broadcast(
                                code,
                                {
                                    "type": "title_update",
                                    "chat_id": session.chat_id,
                                    "title": chat_obj.title,
                                },
                            )

                    except Exception as e:
                        # Unblock inputs on error too
                        await collaboration_manager.broadcast(
                            code,
                            {"type": "typing_done"},
                        )
                        await websocket.send_json({
                            "type": "error",
                            "message": f"Failed to process message: {str(e)}",
                        })

    except WebSocketDisconnect:
        await collaboration_manager.leave_session(code, user.id)
    except Exception:
        await collaboration_manager.leave_session(code, user.id)
