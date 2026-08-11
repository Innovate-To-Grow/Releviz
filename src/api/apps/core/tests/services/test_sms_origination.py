from unittest.mock import MagicMock, patch

from botocore.exceptions import BotoCoreError, ClientError
from django.core.cache import cache
from django.test import TestCase, override_settings

from apps.core.models import AWSCredentialConfig
from apps.core.services.aws import sms as sms_service


def _client_error():
    return ClientError(
        {"Error": {"Code": "AuthorizationError", "Message": "denied"}},
        "DescribePhoneNumbers",
    )


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class ResolveOriginationNumberTest(TestCase):
    def setUp(self):
        cache.clear()
        AWSCredentialConfig.objects.all().delete()
        AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
            default_region="us-west-2",
        )

    def _mock_client(self, mock_boto_client, *pages):
        client = MagicMock()
        client.describe_phone_numbers.side_effect = list(pages)
        mock_boto_client.return_value = client
        return client

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_returns_active_sms_capable_number(self, mock_boto_client):
        self._mock_client(
            mock_boto_client,
            {"PhoneNumbers": [{"PhoneNumber": "+18667724739", "Status": "ACTIVE", "NumberCapabilities": ["SMS"]}]},
        )

        self.assertEqual(sms_service.resolve_origination_number(), "+18667724739")

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_skips_inactive_and_non_sms_numbers(self, mock_boto_client):
        self._mock_client(
            mock_boto_client,
            {
                "PhoneNumbers": [
                    {"PhoneNumber": "+1111", "Status": "PENDING", "NumberCapabilities": ["SMS"]},
                    {"PhoneNumber": "+1222", "Status": "ACTIVE", "NumberCapabilities": ["VOICE"]},
                    {"PhoneNumber": "+1333", "Status": "ACTIVE", "NumberCapabilities": ["SMS", "VOICE"]},
                ]
            },
        )

        self.assertEqual(sms_service.resolve_origination_number(), "+1333")

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_follows_pagination(self, mock_boto_client):
        self._mock_client(
            mock_boto_client,
            {
                "PhoneNumbers": [{"PhoneNumber": "+1222", "Status": "ACTIVE", "NumberCapabilities": ["VOICE"]}],
                "NextToken": "page2",
            },
            {"PhoneNumbers": [{"PhoneNumber": "+1444", "Status": "ACTIVE", "NumberCapabilities": ["SMS"]}]},
        )

        self.assertEqual(sms_service.resolve_origination_number(), "+1444")

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_returns_none_when_no_usable_number(self, mock_boto_client):
        self._mock_client(mock_boto_client, {"PhoneNumbers": []})

        self.assertIsNone(sms_service.resolve_origination_number())

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_caches_result_across_calls(self, mock_boto_client):
        client = self._mock_client(
            mock_boto_client,
            {"PhoneNumbers": [{"PhoneNumber": "+1555", "Status": "ACTIVE", "NumberCapabilities": ["SMS"]}]},
        )

        self.assertEqual(sms_service.resolve_origination_number(), "+1555")
        self.assertEqual(sms_service.resolve_origination_number(), "+1555")
        self.assertEqual(client.describe_phone_numbers.call_count, 1)

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_caches_negative_result(self, mock_boto_client):
        client = self._mock_client(mock_boto_client, {"PhoneNumbers": []}, {"PhoneNumbers": []})

        self.assertIsNone(sms_service.resolve_origination_number())
        self.assertIsNone(sms_service.resolve_origination_number())
        self.assertEqual(client.describe_phone_numbers.call_count, 1)

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_refresh_bypasses_cache(self, mock_boto_client):
        client = self._mock_client(
            mock_boto_client,
            {"PhoneNumbers": [{"PhoneNumber": "+1666", "Status": "ACTIVE", "NumberCapabilities": ["SMS"]}]},
            {"PhoneNumbers": [{"PhoneNumber": "+1666", "Status": "ACTIVE", "NumberCapabilities": ["SMS"]}]},
        )

        sms_service.resolve_origination_number()
        sms_service.resolve_origination_number(refresh=True)
        self.assertEqual(client.describe_phone_numbers.call_count, 2)

    def test_returns_none_without_credentials(self):
        AWSCredentialConfig.objects.all().delete()
        with patch("apps.core.services.aws.sms.boto3.client") as mock_boto_client:
            self.assertIsNone(sms_service.resolve_origination_number())
            mock_boto_client.assert_not_called()

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_client_error_on_cold_cache_returns_none(self, mock_boto_client):
        client = MagicMock()
        client.describe_phone_numbers.side_effect = _client_error()
        mock_boto_client.return_value = client

        self.assertIsNone(sms_service.resolve_origination_number())

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_botocore_error_returns_none(self, mock_boto_client):
        client = MagicMock()
        client.describe_phone_numbers.side_effect = BotoCoreError()
        mock_boto_client.return_value = client

        self.assertIsNone(sms_service.resolve_origination_number())

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_error_returns_stale_cached_value(self, mock_boto_client):
        client = MagicMock()
        client.describe_phone_numbers.side_effect = [
            {"PhoneNumbers": [{"PhoneNumber": "+1777", "Status": "ACTIVE", "NumberCapabilities": ["SMS"]}]},
            _client_error(),
        ]
        mock_boto_client.return_value = client

        self.assertEqual(sms_service.resolve_origination_number(), "+1777")
        # Refresh forces a live call which now fails -> fall back to the cached value.
        self.assertEqual(sms_service.resolve_origination_number(refresh=True), "+1777")

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_origination_number_available(self, mock_boto_client):
        self._mock_client(
            mock_boto_client,
            {"PhoneNumbers": [{"PhoneNumber": "+1888", "Status": "ACTIVE", "NumberCapabilities": ["SMS"]}]},
        )
        self.assertTrue(sms_service.origination_number_available())

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_origination_number_available_false_when_none(self, mock_boto_client):
        self._mock_client(mock_boto_client, {"PhoneNumbers": []})
        self.assertFalse(sms_service.origination_number_available())

    @patch("apps.core.services.aws.sms.boto3.client")
    def test_clear_cache_forces_relist(self, mock_boto_client):
        client = self._mock_client(
            mock_boto_client,
            {"PhoneNumbers": [{"PhoneNumber": "+1999", "Status": "ACTIVE", "NumberCapabilities": ["SMS"]}]},
            {"PhoneNumbers": [{"PhoneNumber": "+1999", "Status": "ACTIVE", "NumberCapabilities": ["SMS"]}]},
        )

        sms_service.resolve_origination_number()
        sms_service.clear_origination_number_cache()
        sms_service.resolve_origination_number()
        self.assertEqual(client.describe_phone_numbers.call_count, 2)

    def test_clear_cache_without_credentials_is_noop(self):
        AWSCredentialConfig.objects.all().delete()
        # Should not raise even though no region can be resolved.
        sms_service.clear_origination_number_cache()


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class ResolvedSmsFromNumberModelTest(TestCase):
    def setUp(self):
        cache.clear()
        AWSCredentialConfig.objects.all().delete()

    def test_manual_override_takes_precedence(self):
        config = AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
            sms_from_number="+12065550000",
        )
        with patch("apps.core.services.aws.sms.resolve_origination_number") as mock_resolve:
            self.assertEqual(config.resolved_sms_from_number(), "+12065550000")
            mock_resolve.assert_not_called()

    @patch("apps.core.services.aws.sms.resolve_origination_number", return_value="+18667724739")
    def test_falls_back_to_auto_resolved_number(self, _mock_resolve):
        config = AWSCredentialConfig.objects.create(
            name="AWS",
            is_active=True,
            access_key_id="aws-key",
            secret_access_key="aws-secret",
        )
        self.assertEqual(config.resolved_sms_from_number(), "+18667724739")

    def test_empty_when_not_configured(self):
        config = AWSCredentialConfig()
        self.assertEqual(config.resolved_sms_from_number(), "")
