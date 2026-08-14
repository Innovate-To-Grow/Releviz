"""Tests for bedrock model catalog + helper functions (AWS mocked)."""

from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.test import SimpleTestCase

from apps.core.services.bedrock.models.catalog import (
    MODEL_CACHE_KEY,
    fetch_inference_profiles,
    fetch_models_from_aws,
    get_available_model_ids,
    get_available_models,
    is_available_bedrock_model_id,
    normalize_bedrock_model_id,
)
from apps.core.services.bedrock.models.discovery import (
    fetch_foundation_models,
    profile_base_model_ids,
    provider_from_id,
)


class FetchFoundationModelsTest(SimpleTestCase):
    def test_groups_models_by_provider(self):
        mgmt = MagicMock()
        mgmt.list_foundation_models.return_value = {
            "modelSummaries": [
                {"modelId": "anthropic.claude", "providerName": "Anthropic", "modelName": "Claude"},
                {"modelId": "amazon.titan"},  # missing provider/name -> defaults
            ]
        }
        result = fetch_foundation_models(mgmt)
        self.assertEqual(result["Anthropic"], [("anthropic.claude", "Claude")])
        # Missing providerName defaults to "Other"; missing modelName defaults to modelId.
        self.assertEqual(result["Other"], [("amazon.titan", "amazon.titan")])

    def test_swallows_aws_failure(self):
        mgmt = MagicMock()
        mgmt.list_foundation_models.side_effect = RuntimeError("boom")
        with patch("apps.core.services.bedrock.models.discovery.logger.warning") as warn:
            result = fetch_foundation_models(mgmt)
        self.assertEqual(result, {})
        warn.assert_called_once_with("list_foundation_models failed")


class ProfileBaseModelIdsTest(SimpleTestCase):
    def test_extracts_base_ids_from_short_prefix(self):
        profiles = {"Anthropic": [("us.anthropic.claude-v2", "Claude")]}
        # "us" prefix (<=3 chars) -> base id is the remainder.
        self.assertEqual(profile_base_model_ids(profiles), {"anthropic.claude-v2"})

    def test_ignores_long_prefixes(self):
        profiles = {"P": [("anthropic.claude", "Claude")]}
        # "anthropic" prefix is >3 chars, so no base id is extracted.
        self.assertEqual(profile_base_model_ids(profiles), set())


class ProviderFromIdTest(SimpleTestCase):
    def test_known_provider_with_region_prefix(self):
        self.assertEqual(provider_from_id("us.anthropic.claude-v2"), "Anthropic")

    def test_known_provider_without_prefix(self):
        self.assertEqual(provider_from_id("amazon.titan"), "Amazon")

    def test_unknown_provider_titlecased(self):
        self.assertEqual(provider_from_id("acme.model"), "Acme")


class NormalizeModelIdTest(SimpleTestCase):
    def test_strips_bedrock_prefix(self):
        self.assertEqual(normalize_bedrock_model_id("bedrock/anthropic.claude"), "anthropic.claude")

    def test_strips_whitespace(self):
        self.assertEqual(normalize_bedrock_model_id("  anthropic.claude  "), "anthropic.claude")

    def test_none_returns_empty(self):
        self.assertEqual(normalize_bedrock_model_id(None), "")


class FetchInferenceProfilesTest(SimpleTestCase):
    def test_collects_system_defined_profiles(self):
        mgmt = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                "inferenceProfileSummaries": [
                    {
                        "type": "SYSTEM_DEFINED",
                        "inferenceProfileId": "us.anthropic.claude-v2",
                        "inferenceProfileName": "Claude",
                    },
                    {"type": "APPLICATION", "inferenceProfileId": "skip.me"},
                ]
            }
        ]
        mgmt.get_paginator.return_value = paginator
        result = fetch_inference_profiles(mgmt)
        self.assertEqual(result["Anthropic"], [("us.anthropic.claude-v2", "Claude")])

    def test_swallows_paginator_failure(self):
        mgmt = MagicMock()
        mgmt.get_paginator.side_effect = RuntimeError("no access")
        with patch("apps.core.services.bedrock.models.catalog.logger.warning") as warn:
            result = fetch_inference_profiles(mgmt)
        self.assertEqual(result, {})
        warn.assert_called_once()


class FetchModelsFromAwsTest(SimpleTestCase):
    def test_empty_when_no_providers(self):
        with (
            patch("apps.core.services.bedrock.models.catalog.get_management_client"),
            patch(
                "apps.core.services.bedrock.models.catalog.fetch_inference_profiles",
                return_value={},
            ),
            patch(
                "apps.core.services.bedrock.models.catalog.fetch_foundation_models", return_value={}
            ),
        ):
            self.assertEqual(fetch_models_from_aws(), [])

    def test_merges_profiles_and_foundation_models(self):
        profiles = {"Anthropic": [("us.anthropic.claude-v2", "Claude Profile")]}
        # foundation model with the same base id should be skipped; a new one added.
        fms = {
            "Anthropic": [
                ("anthropic.claude-v2", "Claude FM"),  # base id already in profiles -> skipped
                ("anthropic.claude-haiku", "Haiku"),  # new -> kept
            ]
        }
        with (
            patch("apps.core.services.bedrock.models.catalog.get_management_client"),
            patch(
                "apps.core.services.bedrock.models.catalog.fetch_inference_profiles",
                return_value=profiles,
            ),
            patch(
                "apps.core.services.bedrock.models.catalog.fetch_foundation_models",
                return_value=fms,
            ),
        ):
            grouped = fetch_models_from_aws()
        self.assertEqual(len(grouped), 1)
        provider, models = grouped[0]
        self.assertEqual(provider, "Anthropic")
        model_ids = {mid for mid, _ in models}
        self.assertIn("us.anthropic.claude-v2", model_ids)
        self.assertIn("anthropic.claude-haiku", model_ids)
        self.assertNotIn("anthropic.claude-v2", model_ids)  # skipped as base of profile

    def test_skips_provider_with_no_models(self):
        # Provider exists only in foundation models but all are filtered out
        # (cannot happen via dedupe here) — instead test an empty provider list.
        with (
            patch("apps.core.services.bedrock.models.catalog.get_management_client"),
            patch(
                "apps.core.services.bedrock.models.catalog.fetch_inference_profiles",
                return_value={"Empty": []},
            ),
            patch(
                "apps.core.services.bedrock.models.catalog.fetch_foundation_models",
                return_value={"Empty": []},
            ),
        ):
            grouped = fetch_models_from_aws()
        self.assertEqual(grouped, [])


class GetAvailableModelsCacheTest(SimpleTestCase):
    def setUp(self):
        cache.delete(MODEL_CACHE_KEY)

    def tearDown(self):
        cache.delete(MODEL_CACHE_KEY)

    def test_returns_cached_value_without_refetch(self):
        cached = [("Cached", [("c.model", "Cached Model")])]
        cache.set(MODEL_CACHE_KEY, cached)
        with patch("apps.core.services.bedrock.models.catalog.fetch_models_from_aws") as fetch:
            result = get_available_models()
        self.assertEqual(result, cached)
        fetch.assert_not_called()

    def test_get_available_model_ids_normalizes(self):
        grouped = [("P", [("bedrock/anthropic.claude", "C"), ("amazon.titan", "T")])]
        with patch(
            "apps.core.services.bedrock.models.catalog.get_available_models",
            return_value=grouped,
        ):
            ids = get_available_model_ids()
        self.assertEqual(ids, {"anthropic.claude", "amazon.titan"})

    def test_is_available_returns_false_for_empty_id(self):
        self.assertFalse(is_available_bedrock_model_id(""))

    def test_is_available_true_when_in_first_lookup(self):
        with patch(
            "apps.core.services.bedrock.models.catalog.get_available_model_ids",
            return_value={"anthropic.claude"},
        ) as ids:
            self.assertTrue(is_available_bedrock_model_id("anthropic.claude"))
        ids.assert_called_once_with()  # no forced refresh needed
