"""Execute a tool call from Bedrock and return the result string."""

import logging

from .registry import TOOL_REGISTRY

logger = logging.getLogger(__name__)


def execute_tool(tool_use):
    """Execute a tool call from Bedrock and return the result string.

    Parameters
    ----------
    tool_use : dict
        A Bedrock ``toolUse`` block with ``name``, ``toolUseId``, and ``input``.

    Returns
    -------
    str
        The tool result text.
    """
    name = tool_use.get("name", "")
    params = tool_use.get("input", {})

    fn = TOOL_REGISTRY.get(name)
    if fn is None:
        return f"Unknown tool: {name}"

    try:
        result = fn(params)
        logger.info("Tool %s executed successfully (%d chars)", name, len(result))
        return result
    except Exception as exc:
        logger.exception("Tool %s failed with params %s", name, params)
        return f"Tool error: {exc}"
