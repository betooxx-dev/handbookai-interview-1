import json
import re
from typing import Optional

from fastapi import HTTPException
from openai import OpenAI, AsyncOpenAI
from sqlalchemy.orm import Session

from config import settings
from models import Chat, Message
from services.chat_service import ChatService
from prompts import WORKFLOW_BASE_PROMPT, WORKFLOW_STREAMING_PROMPT


class WorkflowService:
    @staticmethod
    def create_message_with_ai(chat_id: int, content: str, user_id: int, db: Session) -> Message:
        chat = ChatService.get_chat(chat_id, user_id, db)

        # Save user message
        user_message = Message(chat_id=chat_id, role="user", content=content, user_id=user_id)
        db.add(user_message)
        db.commit()
        db.refresh(user_message)

        # Auto-title on first message
        new_title = None
        if chat.title == "New Conversation":
            message_count = db.query(Message).filter(Message.chat_id == chat_id).count()
            if message_count == 1:
                new_title = content[:50]
                if len(content) > 50:
                    new_title = new_title.rsplit(" ", 1)[0] + "..."
                chat.title = new_title
                db.commit()

        # Generate AI response
        try:
            ai_message = WorkflowService._generate_ai_response(chat_id, content, db)
        except Exception as e:
            print(f"OpenAI Error: {type(e).__name__}: {str(e)}")
            ai_message = WorkflowService._create_fallback_message(chat_id, str(e), db)

        if new_title:
            ai_message.chat_title = new_title

        return ai_message

    @staticmethod
    def update_workflow(message_id: int, workflow_data: dict, user_id: int, db: Session) -> dict:
        from models import ChatMember
        message = (
            db.query(Message)
            .join(Chat, Message.chat_id == Chat.id)
            .join(ChatMember, ChatMember.chat_id == Chat.id)
            .filter(Message.id == message_id, ChatMember.user_id == user_id)
            .first()
        )
        if not message:
            raise HTTPException(status_code=404, detail="Message not found")

        message.workflow_data = workflow_data.get("workflow_data")
        db.commit()
        return {"message": "Workflow updated successfully"}

    @staticmethod
    def get_workflow_history(chat_id: int, user_id: int, db: Session) -> list:
        ChatService.get_chat(chat_id, user_id, db)

        messages = (
            db.query(Message)
            .filter(
                Message.chat_id == chat_id,
                Message.role == "assistant",
                Message.workflow_data.isnot(None),
            )
            .order_by(Message.created_at.desc())
            .all()
        )

        return [
            {"id": msg.id, "workflow_data": msg.workflow_data, "created_at": msg.created_at}
            for msg in messages
        ]

    @staticmethod
    def undo_workflow(chat_id: int, user_id: int, db: Session) -> dict:
        ChatService.get_chat(chat_id, user_id, db)

        last_messages = (
            db.query(Message)
            .filter(Message.chat_id == chat_id)
            .order_by(Message.created_at.desc())
            .limit(2)
            .all()
        )

        if len(last_messages) < 2:
            raise HTTPException(status_code=400, detail="No messages to undo")

        for msg in last_messages:
            db.delete(msg)
        db.commit()

        prev_workflow = (
            db.query(Message)
            .filter(
                Message.chat_id == chat_id,
                Message.role == "assistant",
                Message.workflow_data.isnot(None),
            )
            .order_by(Message.created_at.desc())
            .first()
        )

        return {
            "message": "Undone successfully",
            "workflow_data": prev_workflow.workflow_data if prev_workflow else None,
        }

    # ── Streaming helpers ────────────────────────────────────────

    @staticmethod
    async def stream_ai_response(
        chat_id: int,
        content: str,
        user_id: int,
        db: Session,
        selected_node_ids: Optional[list[str]] = None,
        locked_node_ids: Optional[dict[str, int]] = None,
    ) -> tuple:
        """
        Prepare and return an async OpenAI streaming response plus context
        needed for post-processing.

        Returns (stream, chat, user_message, new_title, last_workflow_data).
        """
        chat = ChatService.get_chat(chat_id, user_id, db)

        # Save user message
        user_message = Message(chat_id=chat_id, role="user", content=content, user_id=user_id)
        db.add(user_message)
        db.commit()
        db.refresh(user_message)

        # Auto-title on first message
        new_title = None
        if chat.title == "New Conversation":
            message_count = db.query(Message).filter(Message.chat_id == chat_id).count()
            if message_count == 1:
                new_title = content[:50]
                if len(content) > 50:
                    new_title = new_title.rsplit(" ", 1)[0] + "..."
                chat.title = new_title
                db.commit()

        # Build OpenAI messages (async client for non-blocking streaming)
        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY, timeout=120.0)

        messages = (
            db.query(Message)
            .filter(Message.chat_id == chat_id)
            .order_by(Message.created_at)
            .all()
        )

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

        conversation = WorkflowService._build_conversation(messages)

        # Build workflow context with node locking info
        workflow_context = ""
        last_workflow_data = None
        if last_workflow_msg and last_workflow_msg.workflow_data:
            last_workflow_data = last_workflow_msg.workflow_data
            try:
                workflow_json = json.loads(last_workflow_data)
                # Mark nodes locked by other users as non-editable
                if locked_node_ids:
                    for node in workflow_json.get("nodes", []):
                        if node["id"] in locked_node_ids:
                            node["editable"] = False
                            node["locked_by_user_id"] = locked_node_ids[node["id"]]
                # Mark non-selected nodes as non-editable for the LLM
                if selected_node_ids:
                    for node in workflow_json.get("nodes", []):
                        if node["id"] not in selected_node_ids and node.get("editable") is not False:
                            node["editable"] = False
                workflow_context = (
                    f"\n\nCURRENT WORKFLOW:\n{json.dumps(workflow_json, indent=2)}\n"
                )
            except (json.JSONDecodeError, KeyError):
                workflow_context = (
                    f"\n\nCURRENT WORKFLOW:\n{last_workflow_data}\n"
                )

        selected_context = ""
        if selected_node_ids:
            selected_context = f"\n\nselected_node_ids (ONLY modify these): {json.dumps(selected_node_ids)}"

        system_message = {
            "role": "system",
            "content": WORKFLOW_STREAMING_PROMPT + workflow_context + selected_context,
        }

        stream = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[system_message] + conversation,
            max_tokens=5000,
            stream=True,
        )

        return stream, chat, user_message, new_title, last_workflow_data

    @staticmethod
    def save_streamed_ai_message(
        chat_id: int,
        display_content: str,
        workflow_data: Optional[str],
        db: Session,
    ) -> Message:
        """Save the final AI message after streaming completes."""
        ai_message = Message(
            chat_id=chat_id,
            role="assistant",
            content=display_content if display_content.strip() else "I've updated the workflow nodes as requested.",
            workflow_data=workflow_data,
        )
        db.add(ai_message)
        db.commit()
        db.refresh(ai_message)
        return ai_message

    @staticmethod
    def apply_node_updates_to_workflow(
        current_workflow_data: Optional[str],
        node_updates: list[dict],
    ) -> Optional[str]:
        """Apply a list of node updates to the current workflow JSON and return the updated string."""
        if not current_workflow_data and not node_updates:
            return None

        if not current_workflow_data:
            # Build a new workflow from the node updates
            nodes = []
            edges = []
            for node_data in node_updates:
                nodes.append({
                    "id": node_data.get("id", "1"),
                    "label": node_data.get("label", node_data.get("title", "Node")),
                    "type": node_data.get("type", "process"),
                })
            # Create simple sequential edges
            for i in range(len(nodes) - 1):
                edges.append({"from": nodes[i]["id"], "to": nodes[i + 1]["id"]})
            return json.dumps({"nodes": nodes, "edges": edges})

        try:
            workflow = json.loads(current_workflow_data)
        except json.JSONDecodeError:
            return current_workflow_data

        for node_data in node_updates:
            node_id = node_data.get("id")
            if not node_id:
                continue

            # Find and update existing node
            found = False
            for i, existing_node in enumerate(workflow.get("nodes", [])):
                if existing_node["id"] == node_id:
                    # Update label from title or label field
                    if "label" in node_data:
                        existing_node["label"] = node_data["label"]
                    elif "title" in node_data:
                        existing_node["label"] = node_data["title"]

                    if "type" in node_data:
                        existing_node["type"] = node_data["type"]

                    if "description" in node_data:
                        existing_node["description"] = node_data["description"]

                    # Remove editable/locked metadata
                    existing_node.pop("editable", None)
                    existing_node.pop("locked_by_user_id", None)

                    workflow["nodes"][i] = existing_node
                    found = True
                    break

            if not found:
                # Add as new node
                new_node = {
                    "id": node_id,
                    "label": node_data.get("label", node_data.get("title", "New Node")),
                    "type": node_data.get("type", "process"),
                }
                if "description" in node_data:
                    new_node["description"] = node_data["description"]
                workflow["nodes"].append(new_node)

        # Clean metadata from all nodes
        for node in workflow.get("nodes", []):
            node.pop("editable", None)
            node.pop("locked_by_user_id", None)

        return json.dumps(workflow)

    # ── Private helpers ──────────────────────────────────────────

    @staticmethod
    def _generate_ai_response(chat_id: int, user_content: str, db: Session) -> Message:
        client = OpenAI(api_key=settings.OPENAI_API_KEY, timeout=120.0)

        messages = (
            db.query(Message)
            .filter(Message.chat_id == chat_id)
            .order_by(Message.created_at)
            .all()
        )

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

        conversation = WorkflowService._build_conversation(messages)

        workflow_context = ""
        if last_workflow_msg and last_workflow_msg.workflow_data:
            workflow_context = (
                f"\n\nCURRENT WORKFLOW (use this as your baseline for any modifications):\n"
                f"{last_workflow_msg.workflow_data}\n\n"
                f"When making changes, start with this exact workflow and ONLY modify what the user specifically requests."
            )

        system_message = {
            "role": "system",
            "content": WORKFLOW_BASE_PROMPT + workflow_context,
        }

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[system_message] + conversation,
            max_tokens=5000,
        )

        ai_content = response.choices[0].message.content

        if not ai_content or len(ai_content.strip()) == 0:
            return WorkflowService._handle_empty_response(chat_id, db)

        workflow_data, display_content = WorkflowService._extract_and_clean(ai_content, user_content)

        ai_message = Message(
            chat_id=chat_id,
            role="assistant",
            content=display_content,
            workflow_data=workflow_data,
        )
        db.add(ai_message)
        db.commit()
        db.refresh(ai_message)
        return ai_message

    @staticmethod
    def _build_conversation(messages: list) -> list:
        conversation = []
        for msg in messages:
            if msg.role == "assistant" and msg.workflow_data:
                content = f"{msg.content}\n\nCurrent workflow JSON:\n{msg.workflow_data}"
                conversation.append({"role": msg.role, "content": content})
            else:
                conversation.append({"role": msg.role, "content": msg.content})
        return conversation

    @staticmethod
    def _extract_json_workflow(text: str):
        # Method 1: JSON in code blocks
        code_block_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if code_block_match:
            try:
                data = json.loads(code_block_match.group(1))
                if "nodes" in data and "edges" in data:
                    return code_block_match.group(1), code_block_match.group(0)
            except Exception:
                pass

        # Method 2: JSON object with nested braces
        json_pattern = r"\{(?:[^{}]|(?:\{(?:[^{}]|(?:\{[^{}]*\}))*\}))*\}"
        json_matches = list(re.finditer(json_pattern, text, re.DOTALL))
        json_matches.sort(key=lambda m: len(m.group(0)), reverse=True)

        for match in json_matches:
            try:
                data = json.loads(match.group(0))
                if "nodes" in data and "edges" in data:
                    if isinstance(data["nodes"], list) and isinstance(data["edges"], list):
                        if len(data["nodes"]) > 0:
                            return match.group(0), match.group(0)
            except Exception:
                continue

        return None, None

    @staticmethod
    def _extract_and_clean(ai_content: str, user_content: str) -> tuple:
        workflow_data = None
        display_content = ai_content

        try:
            extracted_json, full_match = WorkflowService._extract_json_workflow(ai_content)

            if extracted_json:
                workflow_data = extracted_json
                parsed = json.loads(workflow_data)
                if "nodes" not in parsed or "edges" not in parsed:
                    raise ValueError("Invalid workflow structure")
                if len(parsed["nodes"]) == 0:
                    raise ValueError("Workflow has no nodes")

                display_content = ai_content.replace(full_match, "").strip()
                display_content = re.sub(r"```\s*```", "", display_content).strip()
                display_content = re.sub(r"\n\s*\n\s*\n+", "\n\n", display_content)

                if not display_content or len(display_content) < 10:
                    display_content = (
                        "I've created a workflow visualization for you based on your requirements. "
                        "You can see it in the visualization panel on the right."
                    )
            else:
                workflow_keywords = ["workflow", "flowchart", "process", "flujo", "diagrama"]
                if any(kw in user_content.lower() for kw in workflow_keywords):
                    workflow_data = json.dumps(
                        {
                            "nodes": [
                                {"id": "1", "label": "Start", "type": "start"},
                                {"id": "2", "label": "Process request", "type": "process"},
                                {"id": "3", "label": "Complete", "type": "end"},
                            ],
                            "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}],
                        }
                    )
                    display_content = (
                        ai_content
                        if ai_content
                        else "I've created a basic workflow structure for you. You can refine it by describing the specific steps you need."
                    )
        except Exception as parse_error:
            print(f"JSON extraction error: {parse_error}")
            workflow_data = None

        return workflow_data, display_content

    @staticmethod
    def _handle_empty_response(chat_id: int, db: Session) -> Message:
        prev_message = (
            db.query(Message)
            .filter(
                Message.chat_id == chat_id,
                Message.role == "assistant",
                Message.workflow_data.isnot(None),
            )
            .order_by(Message.created_at.desc())
            .first()
        )

        if prev_message and prev_message.workflow_data:
            ai_message = Message(
                chat_id=chat_id,
                role="assistant",
                content="I apologize, I encountered an issue generating a response. I've kept your previous workflow intact. Please try rephrasing your request.",
                workflow_data=prev_message.workflow_data,
            )
            db.add(ai_message)
            db.commit()
            db.refresh(ai_message)
            return ai_message

        raise Exception("Empty response from AI model and no previous workflow available")

    @staticmethod
    def _create_fallback_message(chat_id: int, error: str, db: Session) -> Message:
        fallback_workflow = json.dumps(
            {
                "nodes": [
                    {"id": "1", "label": "Start", "type": "start"},
                    {"id": "2", "label": "Process Request", "type": "process"},
                    {"id": "3", "label": "Decision Point", "type": "decision"},
                    {"id": "4", "label": "Complete", "type": "end"},
                ],
                "edges": [
                    {"from": "1", "to": "2"},
                    {"from": "2", "to": "3"},
                    {"from": "3", "to": "4"},
                ],
            }
        )

        ai_message = Message(
            chat_id=chat_id,
            role="assistant",
            content=f"I can help you design a workflow. Here's a sample process visualization. (Note: OpenAI API is not configured - {error})",
            workflow_data=fallback_workflow,
        )
        db.add(ai_message)
        db.commit()
        db.refresh(ai_message)
        return ai_message
