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


async def _handle_streaming_chat_message(
    code: str, session, user, content: str, selected_node_ids: list[str], db: Session, websocket: WebSocket
):
    """Handle a chat_message by streaming the AI response and broadcasting events."""
    from models import Chat as ChatModel, Message
    from services.stream_parser import StreamParser

    user_info = {"id": user.id, "username": user.username}

    # Step 1: Lock input for ALL users
    await collaboration_manager.broadcast_all(
        code,
        {"type": "input_locked", "user": user_info},
    )

    # Step 2: Lock selected nodes
    actually_locked = []
    if selected_node_ids:
        actually_locked = collaboration_manager.lock_nodes_for_ai(code, selected_node_ids, user.id)
        if actually_locked:
            await collaboration_manager.broadcast_all(
                code,
                {"type": "nodes_locked", "node_ids": actually_locked, "user": user_info},
            )

    # Step 3: Get nodes locked by OTHER users (to mark as editable: false for the AI)
    other_locked = collaboration_manager.get_other_users_locked_nodes(code, user.id)

    # Step 4: Capture title before AI call
    chat_obj = db.query(ChatModel).filter(ChatModel.id == session.chat_id).first()
    old_title = chat_obj.title if chat_obj else None

    # Step 5: Start streaming from OpenAI (async)
    stream, chat, user_message, new_title, last_workflow_data = await WorkflowService.stream_ai_response(
        session.chat_id, content, user.id, db,
        selected_node_ids=selected_node_ids or None,
        locked_node_ids=other_locked or None,
    )

    # Broadcast user message to others
    await collaboration_manager.broadcast(
        code,
        {
            "type": "new_message",
            "message": {
                "id": user_message.id,
                "chat_id": session.chat_id,
                "user_id": user.id,
                "role": "user",
                "content": content,
                "username": user.username,
            },
        },
        exclude_user_id=user.id,
    )

    # Step 6: Process stream with StreamParser
    async def on_parser_event(event):
        """Broadcast parser events to all connected users."""
        if event.event_type == "ai_stream_delta":
            await collaboration_manager.broadcast_all(
                code,
                {"type": "ai_stream_delta", "content": event.data["content"]},
            )
        elif event.event_type == "node_stream_start":
            await collaboration_manager.broadcast_all(
                code,
                {
                    "type": "node_stream_start",
                    "node_id": event.data["node_id"],
                    "node_type": event.data.get("node_type", "process"),
                },
            )
        elif event.event_type == "node_stream_delta":
            await collaboration_manager.broadcast_all(
                code,
                {
                    "type": "node_stream_delta",
                    "node_id": event.data["node_id"],
                    "content": event.data["content"],
                },
            )
        elif event.event_type == "node_stream_done":
            node_data = event.data["data"]
            node_id = event.data["node_id"]

            # Save node update to DB by applying to workflow
            updated_workflow = WorkflowService.apply_node_updates_to_workflow(
                last_workflow_data or session.workflow_data, [node_data]
            )
            if updated_workflow:
                collaboration_manager.update_workflow(code, updated_workflow)
                # Persist to DB
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
                    last_msg.workflow_data = updated_workflow
                    db.commit()

            await collaboration_manager.broadcast_all(
                code,
                {
                    "type": "node_stream_done",
                    "node_id": node_id,
                    "data": node_data,
                },
            )

    parser = StreamParser(on_event=on_parser_event)

    try:
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                token = chunk.choices[0].delta.content
                await parser.feed(token)

        await parser.finish()
    except Exception as stream_error:
        await parser.finish()
        await collaboration_manager.broadcast_all(
            code,
            {"type": "error", "message": f"Stream error: {stream_error}"},
        )

    # Step 7: Save complete AI message to DB
    import re as _re
    full_text = parser.full_text

    # Build final workflow data
    final_workflow = last_workflow_data or session.workflow_data

    if parser.completed_nodes:
        # AI used NODE_START/END delimiters — apply node updates
        final_workflow = WorkflowService.apply_node_updates_to_workflow(
            final_workflow, parser.completed_nodes
        )
        # Clean the chat text by removing delimiter blocks
        chat_text = _re.sub(
            r"---NODE_START:\w+(?::\w+)?---.*?---NODE_END:\w+---",
            "",
            full_text,
            flags=_re.DOTALL,
        ).strip()
        chat_text = _re.sub(r"\n{3,}", "\n\n", chat_text)
    else:
        # FALLBACK: AI responded in old format (JSON embedded in text).
        # Use the existing extraction method to find workflow JSON.
        extracted_json, full_match = WorkflowService._extract_json_workflow(full_text)
        if extracted_json:
            try:
                parsed = json.loads(extracted_json)
                if "nodes" in parsed and "edges" in parsed and len(parsed["nodes"]) > 0:
                    final_workflow = extracted_json
            except (json.JSONDecodeError, KeyError):
                pass

            # Remove JSON from display text
            chat_text = full_text.replace(full_match, "").strip() if full_match else full_text
            chat_text = _re.sub(r"```\s*```", "", chat_text).strip()
            chat_text = _re.sub(r"\n\s*\n\s*\n+", "\n\n", chat_text)
        else:
            chat_text = full_text

        if not chat_text or len(chat_text.strip()) < 5:
            chat_text = "I've updated the workflow as requested."

    if final_workflow:
        collaboration_manager.update_workflow(code, final_workflow)

    ai_message = WorkflowService.save_streamed_ai_message(
        session.chat_id, chat_text, final_workflow, db
    )

    # Broadcast ai_stream_done with the final message
    await collaboration_manager.broadcast_all(
        code,
        {
            "type": "ai_stream_done",
            "message": {
                "id": ai_message.id,
                "chat_id": session.chat_id,
                "role": "assistant",
                "content": ai_message.content,
                "workflow_data": ai_message.workflow_data,
            },
        },
    )

    # Step 8: Unlock nodes
    if actually_locked:
        collaboration_manager.unlock_nodes_for_ai(code, actually_locked, user.id)
        await collaboration_manager.broadcast_all(
            code,
            {"type": "nodes_unlocked", "node_ids": actually_locked},
        )

    # Step 9: Unlock input
    await collaboration_manager.broadcast_all(
        code,
        {"type": "input_unlocked"},
    )

    # Broadcast typing_done for legacy compatibility
    await collaboration_manager.broadcast_all(
        code,
        {"type": "typing_done"},
    )

    # Check if title changed
    if chat_obj:
        db.refresh(chat_obj)
        if chat_obj.title != old_title:
            await collaboration_manager.broadcast_all(
                code,
                {
                    "type": "title_update",
                    "chat_id": session.chat_id,
                    "title": chat_obj.title,
                },
            )


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
                selected_node_ids = data.get("selected_node_ids", [])
                if content:
                    try:
                        await _handle_streaming_chat_message(
                            code, session, user, content, selected_node_ids, db, websocket
                        )
                    except Exception as e:
                        # Unlock everything on error
                        if selected_node_ids:
                            collaboration_manager.unlock_nodes_for_ai(code, selected_node_ids, user.id)
                            await collaboration_manager.broadcast_all(
                                code,
                                {"type": "nodes_unlocked", "node_ids": selected_node_ids},
                            )
                        await collaboration_manager.broadcast_all(
                            code,
                            {"type": "input_unlocked"},
                        )
                        await websocket.send_json({
                            "type": "error",
                            "message": f"Failed to process message: {str(e)}",
                        })

    except WebSocketDisconnect:
        await collaboration_manager.leave_session(code, user.id)
    except Exception:
        await collaboration_manager.leave_session(code, user.id)
