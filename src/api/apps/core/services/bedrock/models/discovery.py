import logging

logger = logging.getLogger(__name__)


def fetch_foundation_models(mgmt):
    models = {}
    try:
        response = mgmt.list_foundation_models(byOutputModality="TEXT", byInferenceType="ON_DEMAND")
        for model in response.get("modelSummaries", []):
            provider = model.get("providerName", "Other")
            models.setdefault(provider, []).append((model["modelId"], model.get("modelName", model["modelId"])))
    except Exception:
        logger.warning("list_foundation_models failed")
    return models


def profile_base_model_ids(profiles_by_provider):
    profile_base_ids = set()
    for models in profiles_by_provider.values():
        for pid, _ in models:
            parts = pid.split(".", 1)
            if len(parts) == 2 and len(parts[0]) <= 3:
                profile_base_ids.add(parts[1])
    return profile_base_ids


def provider_from_id(model_id):
    mapping = {
        "anthropic": "Anthropic",
        "amazon": "Amazon",
        "meta": "Meta",
        "mistral": "Mistral",
        "cohere": "Cohere",
        "ai21": "AI21 Labs",
        "stability": "Stability AI",
    }
    clean = model_id
    parts = model_id.split(".", 1)
    if len(parts) == 2 and len(parts[0]) <= 3:
        clean = parts[1]
    return mapping.get(clean.split(".")[0].lower(), clean.split(".")[0].title())
