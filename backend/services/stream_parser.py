"""
StreamParser: Real-time state machine for parsing OpenAI streaming responses
that contain delimited node blocks mixed with conversational text.

Format expected:
    Conversational text here...

    ---NODE_START:node_id:type---
    Node Label Text
    Optional description on next lines
    ---NODE_END:node_id---

    More conversational text...

If the AI doesn't use delimiters, all text is emitted as ai_stream_delta.
The caller should add a fallback to extract JSON from the full text.
"""

import re
from typing import Callable, Awaitable, Optional
from dataclasses import dataclass, field


@dataclass
class StreamEvent:
    """Represents an event emitted by the parser."""
    event_type: str
    data: dict = field(default_factory=dict)


NODE_START_PATTERN = re.compile(r"---NODE_START:(\w+):(\w+)---")
NODE_END_PATTERN = re.compile(r"---NODE_END:(\w+)---")

# Maximum possible length of a delimiter like ---NODE_START:some_long_id:process---
MAX_DELIMITER_LEN = 50


class StreamParser:
    """
    Processes OpenAI stream tokens and emits structured events.

    Uses a simple buffer strategy: always keep the last MAX_DELIMITER_LEN
    characters in the buffer to handle tokens that split across delimiters.

    States:
        CHAT_TEXT    - accumulates conversational text, watches for NODE_START
        NODE_CONTENT - accumulates plain text for a node, watches for NODE_END
    """

    def __init__(self, on_event: Callable[[StreamEvent], Awaitable[None]]):
        self._on_event = on_event
        self._state = "CHAT_TEXT"
        self._buffer = ""
        self._current_node_id: Optional[str] = None
        self._current_node_type: Optional[str] = None
        self._node_buffer = ""
        self._full_text = ""
        self._completed_nodes: list[dict] = []

    async def feed(self, token: str) -> None:
        """Feed a single token from the OpenAI stream."""
        self._full_text += token
        self._buffer += token
        await self._flush()

    async def finish(self) -> None:
        """Called when the stream ends. Flushes any remaining buffer."""
        if self._state == "CHAT_TEXT":
            if self._buffer:
                await self._emit(StreamEvent("ai_stream_delta", {"content": self._buffer}))
                self._buffer = ""
        elif self._state == "NODE_CONTENT":
            # Stream ended mid-node — finalize with what we have
            self._node_buffer += self._buffer
            self._buffer = ""
            await self._finalize_node()
            self._state = "CHAT_TEXT"
            self._current_node_id = None
            self._current_node_type = None

    @property
    def full_text(self) -> str:
        """The complete accumulated text from the stream."""
        return self._full_text

    @property
    def completed_nodes(self) -> list[dict]:
        """List of fully parsed node data dicts."""
        return self._completed_nodes

    async def _flush(self) -> None:
        """Process the buffer, looking for delimiters and emitting events."""
        while True:
            if self._state == "CHAT_TEXT":
                consumed = await self._flush_chat_text()
                if not consumed:
                    break
            elif self._state == "NODE_CONTENT":
                consumed = await self._flush_node_content()
                if not consumed:
                    break

    async def _flush_chat_text(self) -> bool:
        """Process buffer in CHAT_TEXT state. Returns True if it consumed something."""
        match = NODE_START_PATTERN.search(self._buffer)
        if match:
            # Emit text before the delimiter
            before = self._buffer[:match.start()]
            if before:
                await self._emit(StreamEvent("ai_stream_delta", {"content": before}))

            # Switch to NODE_CONTENT state
            self._current_node_id = match.group(1)
            self._current_node_type = match.group(2)
            self._node_buffer = ""
            self._state = "NODE_CONTENT"
            self._buffer = self._buffer[match.end():]

            await self._emit(StreamEvent("node_stream_start", {
                "node_id": self._current_node_id,
                "node_type": self._current_node_type,
            }))
            return True
        else:
            # No complete delimiter found. Emit what's safe to emit,
            # keeping a tail buffer in case a delimiter is split across tokens.
            safe_len = max(0, len(self._buffer) - MAX_DELIMITER_LEN)
            if safe_len > 0:
                to_emit = self._buffer[:safe_len]
                self._buffer = self._buffer[safe_len:]
                await self._emit(StreamEvent("ai_stream_delta", {"content": to_emit}))
            return False

    async def _flush_node_content(self) -> bool:
        """Process buffer in NODE_CONTENT state. Returns True if it consumed something."""
        match = NODE_END_PATTERN.search(self._buffer)
        if match:
            # Content before the end delimiter is the node label/description
            text_part = self._buffer[:match.start()]
            self._node_buffer += text_part
            if text_part.strip():
                await self._emit(StreamEvent("node_stream_delta", {
                    "node_id": self._current_node_id,
                    "content": text_part,
                }))

            # Finalize the node
            await self._finalize_node()

            # Switch back to CHAT_TEXT
            self._buffer = self._buffer[match.end():]
            self._state = "CHAT_TEXT"
            self._current_node_id = None
            self._current_node_type = None
            return True
        else:
            # No complete end delimiter. Emit safe portion of node content.
            safe_len = max(0, len(self._buffer) - MAX_DELIMITER_LEN)
            if safe_len > 0:
                chunk = self._buffer[:safe_len]
                self._buffer = self._buffer[safe_len:]
                self._node_buffer += chunk
                if chunk.strip():
                    await self._emit(StreamEvent("node_stream_delta", {
                        "node_id": self._current_node_id,
                        "content": chunk,
                    }))
            return False

    async def _finalize_node(self) -> None:
        """Parse the accumulated plain text for a node and emit node_stream_done."""
        raw_text = self._node_buffer.strip()
        lines = [line.strip() for line in raw_text.split("\n") if line.strip()]

        label = lines[0] if lines else "Node"
        description = "\n".join(lines[1:]) if len(lines) > 1 else ""

        node_data = {
            "id": self._current_node_id,
            "label": label,
            "type": self._current_node_type or "process",
        }
        if description:
            node_data["description"] = description

        self._completed_nodes.append(node_data)

        await self._emit(StreamEvent("node_stream_done", {
            "node_id": self._current_node_id,
            "data": node_data,
        }))

    async def _emit(self, event: StreamEvent) -> None:
        """Emit an event to the callback."""
        await self._on_event(event)
