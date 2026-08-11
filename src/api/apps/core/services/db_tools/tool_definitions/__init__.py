"""Bedrock tool definitions for the AI chat tool-use integration."""

from .registry import TOOL_DEFINITIONS


def get_tool_definitions():
    """Return the list of tool definitions for the Bedrock Converse API."""
    return list(TOOL_DEFINITIONS)
