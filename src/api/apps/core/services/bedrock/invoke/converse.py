import logging

from botocore.exceptions import ClientError

from apps.core.services.db_tools import execute_tool

from ..clients.prepare import prepare
from ..constants import MAX_TOOL_ROUNDS
from ..exceptions import BedrockError

logger = logging.getLogger(__name__)


def invoke_bedrock(conversation_messages, *, chat_config=None, aws_config=None, model_id=None):
    """Call the Bedrock Converse API (non-streaming)."""
    client, messages, kwargs = prepare(conversation_messages, chat_config, aws_config, model_id)
    tool_calls_log = []
    for round_num in range(MAX_TOOL_ROUNDS):
        kwargs["messages"] = messages
        try:
            response = client.converse(**kwargs)
        except ClientError as exc:
            logger.exception("Bedrock Converse API error (round %d)", round_num)
            raise BedrockError(f"Bedrock API error: {exc}") from exc
        except Exception as exc:
            logger.exception("Unexpected error calling Bedrock (round %d)", round_num)
            raise BedrockError(f"Unexpected error: {exc}") from exc
        output_message = response["output"]["message"]
        messages.append(output_message)
        if response.get("stopReason") == "tool_use":
            messages.append({"role": "user", "content": collect_tool_results(output_message, tool_calls_log)})
            continue
        text_parts = [block["text"] for block in output_message["content"] if "text" in block]
        return {"text": "".join(text_parts), "tool_calls": tool_calls_log}
    return {
        "text": "I was unable to complete the request within the allowed number of steps.",
        "tool_calls": tool_calls_log,
    }


def collect_tool_results(output_message, tool_calls_log):
    tool_results = []
    for block in output_message["content"]:
        if "toolUse" not in block:
            continue
        tool_info = block["toolUse"]
        result_text = execute_tool(tool_info)
        tool_calls_log.append(
            {
                "name": tool_info.get("name", "unknown"),
                "input": tool_info.get("input", {}),
                "result_preview": result_text[:200],
            }
        )
        tool_results.append({"toolResult": {"toolUseId": tool_info["toolUseId"], "content": [{"text": result_text}]}})
    return tool_results
