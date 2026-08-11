from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase

from apps.core.services.bedrock.models.catalog import (
    MODEL_CACHE_KEY,
    get_available_models,
    is_available_bedrock_model_id,
)


class BedrockModelCatalogTests(SimpleTestCase):
    def setUp(self):
        cache.delete(MODEL_CACHE_KEY)

    def tearDown(self):
        cache.delete(MODEL_CACHE_KEY)

    def test_available_models_come_from_dynamic_aws_fetch(self):
        grouped = [("Future Provider", [("future.model-id-v9:0", "Future Model")])]

        with patch("apps.core.services.bedrock.models.catalog.fetch_models_from_aws", return_value=grouped):
            self.assertEqual(get_available_models(force_refresh=True), grouped)

    def test_available_models_return_empty_when_aws_fetch_fails(self):
        with (
            patch("apps.core.services.bedrock.models.catalog.fetch_models_from_aws", side_effect=RuntimeError("down")),
            patch("apps.core.services.bedrock.models.catalog.logger.exception") as log_exception,
        ):
            self.assertEqual(get_available_models(force_refresh=True), [])
        log_exception.assert_called_once_with("Failed to fetch Bedrock models from AWS")

    def test_model_id_validation_refreshes_stale_cache(self):
        cache.set(MODEL_CACHE_KEY, [("Old Provider", [("old.model-v1", "Old Model")])])
        grouped = [("New Provider", [("new.dynamic-model-v1:0", "New Model")])]

        with patch("apps.core.services.bedrock.models.catalog.fetch_models_from_aws", return_value=grouped) as fetch:
            self.assertTrue(is_available_bedrock_model_id("bedrock/new.dynamic-model-v1:0"))

        fetch.assert_called_once()
