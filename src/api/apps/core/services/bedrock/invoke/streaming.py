import logging

from botocore.exceptions import ClientError

from ..clients.prepare import prepare
from ..constants import MAX_TOOL_ROUNDS
from ..exceptions import BedrockError
from .stream_parser import process_stream_response, stream_tool_results

logger = logging.getLogger(__name__)


def invoke_bedrock_stream(
    conversation_messages, *, chat_config=None, aws_config=None, model_id=None
):
    """Call the Bedrock ConverseStream API with tool-use loop."""
    try:
        client, messages, kwargs = prepare(conversation_messages, chat_config, aws_config, model_id)
    except BedrockError as exc:
        yield {"type": "error", "error": str(exc)}
        return
    for round_num in range(MAX_TOOL_ROUNDS):
        kwargs["messages"] = messages
        try:
            response = client.converse_stream(**kwargs)
        except ClientError as exc:
            logger.exception("Bedrock ConverseStream error (round %d)", round_num)
            yield {"type": "error", "error": f"Bedrock API error: {exc}"}
            return
        except Exception as exc:
            logger.exception("Unexpected error calling Bedrock stream (round %d)", round_num)
            yield {"type": "error", "error": f"Unexpected error: {exc}"}
            return
        outcome = yield from process_stream_response(response)
        messages.append({"role": "assistant", "content": outcome["content_blocks"]})
        yield {"type": "usage", **outcome["usage"]}
        if outcome["stop_reason"] == "tool_use":
            tool_results = []
            for event, result in stream_tool_results(outcome["content_blocks"], round_num):
                yield event
                tool_results.append(result)
            messages.append({"role": "user", "content": tool_results})
            continue
        return
    yield {"type": "error", "error": "Too many tool-use rounds."}
