"""
Prompt loader for workflow system prompts.

Loads prompt files from the prompts/ directory at import time
and exposes them as module-level constants.
"""

import os

_PROMPTS_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_prompt(filename: str) -> str:
    """Read a prompt file and return its contents as a string."""
    filepath = os.path.join(_PROMPTS_DIR, filename)
    with open(filepath, "r", encoding="utf-8") as f:
        return f.read()


WORKFLOW_BASE_PROMPT = _load_prompt("workflow_base.md")
WORKFLOW_STREAMING_PROMPT = _load_prompt("workflow_streaming.md")
