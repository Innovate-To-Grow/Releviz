from apps.core.services.db_tools import get_tool_definitions
from apps.system_intelligence.models import SystemIntelligenceConfig

from ..exceptions import BedrockError
from ._aws import get_client


def build_kwargs(chat_config, model_id):
    """Build common kwargs shared by converse and converse_stream."""
    kwargs = {
        "modelId": model_id,
        "inferenceConfig": {
            "maxTokens": chat_config.max_tokens,
            "temperature": chat_config.temperature,
        },
    }
    if chat_config.system_prompt:
        kwargs["system"] = [{"text": chat_config.system_prompt}]
    tool_defs = get_tool_definitions()
    if tool_defs:
        kwargs["toolConfig"] = {"tools": tool_defs}
    return kwargs


def prepare(conversation_messages, chat_config, aws_config, model_id=None):
    """Validate configs and return (client, messages, kwargs)."""
    if chat_config is None:
        chat_config = SystemIntelligenceConfig.load()
    if not chat_config.is_configured:
        raise BedrockError("AI Chat is not configured. Add an active AI Chat Config first.")
    if not model_id:
        model_id = chat_config.default_model_id
    client = get_client(aws_config)
    messages = [
        {"role": m["role"], "content": [{"text": m["content"]}]} for m in conversation_messages
    ]
    return client, messages, build_kwargs(chat_config, model_id)
