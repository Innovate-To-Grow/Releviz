import logging

from django.core.cache import cache

from ..clients._aws import get_management_client
from .discovery import fetch_foundation_models, profile_base_model_ids, provider_from_id

logger = logging.getLogger(__name__)

MODEL_CACHE_KEY = "bedrock_available_models"
MODEL_CACHE_TTL = 600


def get_available_models(force_refresh=False):
    """Return available Bedrock models grouped by provider."""
    if not force_refresh:
        cached = cache.get(MODEL_CACHE_KEY)
        if cached is not None:
            return cached
    try:
        result = fetch_models_from_aws()
        cache.set(MODEL_CACHE_KEY, result, MODEL_CACHE_TTL)
        return result
    except Exception:
        logger.exception("Failed to fetch Bedrock models from AWS")
        return []


def fetch_models_from_aws():
    mgmt = get_management_client()
    profiles_by_provider = fetch_inference_profiles(mgmt)
    fm_by_provider = fetch_foundation_models(mgmt)
    all_providers = set(profiles_by_provider) | set(fm_by_provider)
    if not all_providers:
        return []
    profile_base_ids = profile_base_model_ids(profiles_by_provider)
    grouped = []
    for provider in sorted(all_providers):
        models = list(profiles_by_provider.get(provider, []))
        for mid, name in fm_by_provider.get(provider, []):
            if mid not in profile_base_ids and not any(model[0] == mid for model in models):
                models.append((mid, name))
        if models:
            models.sort(key=lambda model: model[1])
            grouped.append((provider, models))
    return grouped


def fetch_inference_profiles(mgmt):
    profiles = {}
    try:
        for page in mgmt.get_paginator("list_inference_profiles").paginate():
            for profile in page.get("inferenceProfileSummaries", []):
                if profile.get("type") != "SYSTEM_DEFINED":
                    continue
                pid = profile["inferenceProfileId"]
                profiles.setdefault(provider_from_id(pid), []).append(
                    (pid, profile.get("inferenceProfileName", pid))
                )
    except Exception:
        logger.warning("list_inference_profiles failed, will use foundation models only")
    return profiles


def normalize_bedrock_model_id(model_id: str) -> str:
    model_id = (model_id or "").strip()
    if model_id.startswith("bedrock/"):
        return model_id.removeprefix("bedrock/")
    return model_id


def get_available_model_ids(force_refresh=False) -> set[str]:
    model_ids = set()
    for _group, models in get_available_models(force_refresh=force_refresh):
        model_ids.update(normalize_bedrock_model_id(model_id) for model_id, _name in models)
    return model_ids


def is_available_bedrock_model_id(model_id: str) -> bool:
    normalized_model_id = normalize_bedrock_model_id(model_id)
    if not normalized_model_id:
        return False
    if normalized_model_id in get_available_model_ids():
        return True
    return normalized_model_id in get_available_model_ids(force_refresh=True)
