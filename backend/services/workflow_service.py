import json
import re
from typing import Optional

from fastapi import HTTPException
from openai import AsyncOpenAI
from sqlalchemy.orm import Session

from config import settings
from models import Chat, Message
from services.chat_service import ChatService
from prompts import WORKFLOW_STREAMING_PROMPT


class WorkflowService:
    @staticmethod
    async def create_message_with_ai(
        chat_id: int, content: str, user_id: int, db: Session,
        selected_node_ids: Optional[list[str]] = None,
    ) -> Message:
        from services.stream_parser import StreamParser

        # Get streaming response + context (saves user message, handles auto-title)
        try:
            stream, chat, user_message, new_title, last_workflow_data = (
                await WorkflowService.stream_ai_response(
                    chat_id, content, user_id, db,
                    selected_node_ids=selected_node_ids,
                )
            )
        except Exception as e:
            print(f"OpenAI Error: {type(e).__name__}: {str(e)}")
            return WorkflowService._create_fallback_message(chat_id, str(e), db)

        # Compute existing node IDs for server-side validation
        existing_node_ids = set()
        if last_workflow_data:
            try:
                existing_node_ids = {n.get("id") for n in json.loads(last_workflow_data).get("nodes", [])}
            except Exception:
                pass

        # Consume stream locally with StreamParser (no broadcasting for HTTP path)
        async def on_event(event):
            nonlocal last_workflow_data
            if event.event_type in ("node_stream_start", "node_stream_delta", "node_stream_done"):
                node_id = event.data.get("node_id")
                if selected_node_ids and node_id in existing_node_ids and node_id not in selected_node_ids:
                    return  # Reject unauthorized node modification
            if event.event_type == "node_stream_done":
                node_data = event.data["data"]
                updated = WorkflowService.apply_node_updates_to_workflow(
                    last_workflow_data, [node_data]
                )
                if updated:
                    last_workflow_data = updated

        parser = StreamParser(on_event=on_event)

        try:
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta and delta.content:
                    await parser.feed(delta.content)
            await parser.finish()
        except Exception as e:
            print(f"[STREAM ERROR] {type(e).__name__}: {e}")
            await parser.finish()

        # Build final display text
        full_text = parser.full_text
        final_workflow = last_workflow_data

        if parser.completed_nodes:
            chat_text = re.sub(
                r"---NODE_START:\w+(?::\w+)?---.*?---NODE_END:\w+---",
                "", full_text, flags=re.DOTALL,
            ).strip()
            chat_text = re.sub(r"\n{3,}", "\n\n", chat_text)
        else:
            # Fallback: try to extract JSON workflow
            extracted_json, full_match = WorkflowService._extract_json_workflow(full_text)
            if extracted_json:
                try:
                    parsed = json.loads(extracted_json)
                    if "nodes" in parsed and "edges" in parsed and len(parsed["nodes"]) > 0:
                        final_workflow = extracted_json
                except (json.JSONDecodeError, KeyError):
                    pass
                chat_text = full_text.replace(full_match, "").strip() if full_match else full_text
                chat_text = re.sub(r"```\s*```", "", chat_text).strip()
                chat_text = re.sub(r"\n\s*\n\s*\n+", "\n\n", chat_text)
            else:
                chat_text = full_text

        if not chat_text or len(chat_text.strip()) < 5:
            chat_text = "I've updated the workflow as requested."

        ai_message = WorkflowService.save_streamed_ai_message(
            chat_id, chat_text, final_workflow, db,
        )

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
                    f"\n\n<current_workflow>\n{json.dumps(workflow_json, indent=2)}\n</current_workflow>\n"
                )
            except (json.JSONDecodeError, KeyError):
                workflow_context = (
                    f"\n\n<current_workflow>\n{last_workflow_data}\n</current_workflow>\n"
                )

        selected_context = ""
        if selected_node_ids:
            # Include labels so the LLM can match IDs to node names
            selected_details = []
            if last_workflow_data:
                try:
                    wf_nodes = json.loads(last_workflow_data).get("nodes", [])
                    node_map = {n["id"]: n.get("label", "Unknown") for n in wf_nodes}
                    for nid in selected_node_ids:
                        label = node_map.get(nid, "Unknown")
                        selected_details.append(f'  - id="{nid}" label="{label}"')
                except (json.JSONDecodeError, KeyError):
                    pass
            if selected_details:
                details = "\n".join(selected_details)
                selected_context = (
                    f"\n\nSELECTED NODES — Use ---NODE_START:ID:TYPE--- delimiters for these:\n"
                    f"{details}\n"
                    f"You MUST output delimiter blocks for any changes to these nodes. Do NOT just describe the changes in text."
                )
            else:
                selected_context = f"\n\nselected_node_ids (ONLY modify these): {json.dumps(selected_node_ids)}"

        system_message = {
            "role": "system",
            "content": WORKFLOW_STREAMING_PROMPT + workflow_context + selected_context,
        }

        # Inject selected node info into the last user message so the AI
        # knows what "this node" / "este nodo" refers to
        if selected_node_ids and conversation and conversation[-1]["role"] == "user":
            try:
                wf_nodes = json.loads(last_workflow_data).get("nodes", []) if last_workflow_data else []
                node_map = {n["id"]: n.get("label", "") for n in wf_nodes}
                parts = [f'#{nid} "{node_map.get(nid, "")}"' for nid in selected_node_ids]
                prefix = f'[The user selected node(s): {", ".join(parts)}]\n\n'
                conversation = conversation.copy()
                conversation[-1] = {**conversation[-1], "content": prefix + conversation[-1]["content"]}
            except Exception:
                pass

        stream = await client.chat.completions.create(
            model="gpt-5-mini",
            messages=[system_message] + conversation,
            max_completion_tokens=5000,
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

            # Handle node deletion — reconnect edges through the deleted node
            if node_data.get("type") == "delete":
                # Find sources and targets of the deleted node
                sources = [e.get("from") for e in workflow.get("edges", []) if e.get("to") == node_id]
                targets = [e.get("to") for e in workflow.get("edges", []) if e.get("from") == node_id]

                # Remove the node and its edges
                workflow["nodes"] = [n for n in workflow.get("nodes", []) if n["id"] != node_id]
                workflow["edges"] = [
                    e for e in workflow.get("edges", [])
                    if e.get("from") != node_id and e.get("to") != node_id
                ]

                # Reconnect: each source → each target
                existing_edges = {(e["from"], e["to"]) for e in workflow.get("edges", [])}
                for src in sources:
                    for tgt in targets:
                        if src != tgt and (src, tgt) not in existing_edges:
                            workflow["edges"].append({"from": src, "to": tgt})
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

                # Auto-connect: insert new node before the first end node
                edges = workflow.get("edges", [])
                node_type = new_node.get("type", "process")

                if node_type == "end":
                    # End node: connect from leaf nodes (nodes with no outgoing edges)
                    all_sources = {e.get("from") for e in edges}
                    all_ids = {n["id"] for n in workflow.get("nodes", []) if n["id"] != node_id}
                    leaves = [nid for nid in all_ids if nid not in all_sources]
                    for leaf in leaves:
                        edges.append({"from": leaf, "to": node_id})
                elif node_type == "start":
                    # Start node: connect to first node that has no incoming edges
                    all_targets = {e.get("to") for e in edges}
                    all_ids = [n["id"] for n in workflow.get("nodes", []) if n["id"] != node_id]
                    roots = [nid for nid in all_ids if nid not in all_targets]
                    for root in roots:
                        edges.append({"from": node_id, "to": root})
                else:
                    # Process/decision: insert before the first end node
                    end_nodes = [n for n in workflow.get("nodes", []) if n.get("type") == "end"]
                    inserted = False
                    if end_nodes:
                        end_id = end_nodes[0]["id"]
                        incoming = [e for e in edges if e.get("to") == end_id]
                        if incoming:
                            # Take the last incoming edge to the end node
                            pred_edge = incoming[-1]
                            pred_id = pred_edge["from"]
                            edges.remove(pred_edge)
                            edges.append({"from": pred_id, "to": node_id})
                            edges.append({"from": node_id, "to": end_id})
                            inserted = True
                    if not inserted:
                        # No end node — append after the last leaf node
                        all_sources = {e.get("from") for e in edges}
                        all_ids = [n["id"] for n in workflow.get("nodes", []) if n["id"] != node_id]
                        leaves = [nid for nid in all_ids if nid not in all_sources]
                        if leaves:
                            edges.append({"from": leaves[-1], "to": node_id})

                workflow["edges"] = edges

        # Clean metadata from all nodes
        for node in workflow.get("nodes", []):
            node.pop("editable", None)
            node.pop("locked_by_user_id", None)

        return json.dumps(workflow)

    # ── Private helpers ──────────────────────────────────────────

    @staticmethod
    def _build_conversation(messages: list, include_workflow_json: bool = True) -> list:
        conversation = []
        for msg in messages:
            if msg.role == "assistant" and msg.workflow_data and include_workflow_json:
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
