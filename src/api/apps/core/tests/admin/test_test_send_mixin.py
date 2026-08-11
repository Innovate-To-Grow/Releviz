"""Tests for TestSendViewsMixin and its helper functions (all network mocked)."""

from unittest.mock import MagicMock, patch

from django.contrib.admin.sites import AdminSite
from django.contrib.messages.storage.fallback import FallbackStorage
from django.test import RequestFactory, TestCase
from django.urls import reverse

from apps.core.admin.service_credentials.aws import AWSCredentialConfigAdmin
from apps.core.admin.service_credentials.helpers import (
    _normalize_phone_number,
    _send_test_email,
    _send_test_sms,
)
from apps.core.models import AWSCredentialConfig, EmailServiceConfig
from apps.core.services.aws.credentials import AwsCredentials, AwsCredentialsError
from apps.event.tests.helpers import make_superuser


def _admin():
    return AWSCredentialConfigAdmin(AWSCredentialConfig, AdminSite())


def _request(method, user, data=None, path="/admin/test-email/"):
    factory = RequestFactory()
    if method == "post":
        request = factory.post(path, data=data or {})
    else:
        request = factory.get(path)
    request.user = user
    request.session = {}
    request._messages = FallbackStorage(request)
    return request


def _messages(request):
    return [str(m) for m in request._messages]


# ---------- helpers ----------


class NormalizePhoneTest(TestCase):
    def test_strips_plus_and_prepends_country_code(self):
        self.assertEqual(_normalize_phone_number("+1", "+12065551234"), "+112065551234")

    def test_empty_recipient_returns_empty(self):
        self.assertEqual(_normalize_phone_number("+1", "   "), "")


class SendTestEmailHelperTest(TestCase):
    def test_not_configured_raises(self):
        config = EmailServiceConfig(name="C")
        with patch.object(type(config), "ses_configured", property(lambda self: False)):
            with self.assertRaises(RuntimeError) as cm:
                _send_test_email(config=config, recipient="x@example.com")
        self.assertIn("Email delivery is not configured", str(cm.exception))

    def test_success_returns_provider(self):
        config = EmailServiceConfig(name="C", ses_from_email="from@x.com", ses_from_name="I2G")
        creds = AwsCredentials(access_key_id="K", secret_access_key="S", region="us-west-2")
        client = MagicMock()
        with (
            patch.object(type(config), "ses_configured", property(lambda self: True)),
            patch("apps.core.admin.service_credentials.helpers.resolve_aws_credentials", return_value=creds),
            patch("boto3.client", return_value=client),
        ):
            provider = _send_test_email(config=config, recipient="to@example.com")
        self.assertEqual(provider, "AWS SES")
        client.send_email.assert_called_once()

    def test_credentials_error_raises_runtime(self):
        config = EmailServiceConfig(name="C")
        with (
            patch.object(type(config), "ses_configured", property(lambda self: True)),
            patch(
                "apps.core.admin.service_credentials.helpers.resolve_aws_credentials",
                side_effect=AwsCredentialsError("none"),
            ),
        ):
            with self.assertRaises(RuntimeError) as cm:
                _send_test_email(config=config, recipient="to@example.com")
        self.assertIn("AWS credentials are not configured", str(cm.exception))

    def test_send_failure_raises_runtime(self):
        config = EmailServiceConfig(name="C", ses_from_email="from@x.com")
        creds = AwsCredentials(access_key_id="K", secret_access_key="S", region="us-west-2")
        client = MagicMock()
        client.send_email.side_effect = RuntimeError("boom")
        with (
            patch.object(type(config), "ses_configured", property(lambda self: True)),
            patch("apps.core.admin.service_credentials.helpers.resolve_aws_credentials", return_value=creds),
            patch("boto3.client", return_value=client),
        ):
            with self.assertRaises(RuntimeError) as cm:
                _send_test_email(config=config, recipient="to@example.com")
        self.assertIn("AWS SES test send failed", str(cm.exception))


class SendTestSmsHelperTest(TestCase):
    def test_returns_message_id(self):
        with patch(
            "apps.authn.services.sms.publish_plain_sms",
            return_value="msg-123",
        ) as pub:
            result = _send_test_sms(phone_number="+112065551234")
        self.assertEqual(result, "message (ID: msg-123)")
        pub.assert_called_once()


# ---------- mixin views ----------


class TestEmailViewTest(TestCase):
    def setUp(self):
        self.user = make_superuser()
        self.admin = _admin()

    def test_get_renders_form(self):
        request = _request("get", self.user)
        with patch.object(EmailServiceConfig, "load", return_value=EmailServiceConfig(name="Prod")):
            response = self.admin.test_email_list_view(request)
        self.assertEqual(response.template_name, "admin/core/test_send_form.html")
        self.assertIn("Send Test Email", response.context_data["title"])

    def test_post_missing_recipient_errors(self):
        request = _request("post", self.user, {"recipient": ""})
        with patch.object(EmailServiceConfig, "load", return_value=EmailServiceConfig(name="Prod")):
            response = self.admin.test_email_list_view(request)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse("admin:core_awscredentialconfig_test_email"))
        self.assertIn("Please provide a recipient email address.", _messages(request))

    def test_post_success(self):
        request = _request("post", self.user, {"recipient": "to@example.com"})
        with (
            patch.object(EmailServiceConfig, "load", return_value=EmailServiceConfig(name="Prod")),
            patch(
                "apps.core.admin.service_credentials.test_send_mixin._send_test_email",
                return_value="AWS SES",
            ),
        ):
            response = self.admin.test_email_list_view(request)
        self.assertEqual(response.status_code, 302)
        self.assertTrue(any("Test email sent to to@example.com" in m for m in _messages(request)))

    def test_post_failure(self):
        request = _request("post", self.user, {"recipient": "to@example.com"})
        with (
            patch.object(EmailServiceConfig, "load", return_value=EmailServiceConfig(name="Prod")),
            patch(
                "apps.core.admin.service_credentials.test_send_mixin._send_test_email",
                side_effect=RuntimeError("nope"),
            ),
        ):
            self.admin.test_email_list_view(request)
        self.assertTrue(any("Failed to send test email: nope" in m for m in _messages(request)))

    def test_action_redirect(self):
        request = _request("get", self.user)
        response = self.admin.test_email_list(request)
        self.assertEqual(response.status_code, 302)
        self.assertIn("test-email", response.url)


class TestSmsViewTest(TestCase):
    def setUp(self):
        self.user = make_superuser()
        self.admin = _admin()

    def test_get_renders_form(self):
        request = _request("get", self.user, path="/admin/test-sms/")
        with patch.object(AWSCredentialConfig, "load", return_value=AWSCredentialConfig(name="AWS")):
            response = self.admin.test_sms_list_view(request)
        self.assertEqual(response.template_name, "admin/core/test_send_form.html")
        self.assertIn("Send Test SMS", response.context_data["title"])

    def test_post_missing_recipient_redirects_to_canonical_form(self):
        request = _request("post", self.user, {"recipient": ""}, path="//attacker.example")
        with patch.object(AWSCredentialConfig, "load", return_value=AWSCredentialConfig(name="AWS")):
            response = self.admin.test_sms_list_view(request)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse("admin:core_awscredentialconfig_test_sms"))
        self.assertIn("Please provide a phone number.", _messages(request))

    def test_post_missing_recipient_errors(self):
        request = _request("post", self.user, {"recipient": ""}, path="/admin/test-sms/")
        with patch.object(AWSCredentialConfig, "load", return_value=AWSCredentialConfig(name="AWS")):
            response = self.admin.test_sms_list_view(request)
        self.assertEqual(response.status_code, 302)
        self.assertIn("Please provide a phone number.", _messages(request))

    def test_post_success(self):
        request = _request(
            "post", self.user, {"country_code": "+1", "recipient": "2065551234"}, path="/admin/test-sms/"
        )
        with (
            patch.object(AWSCredentialConfig, "load", return_value=AWSCredentialConfig(name="AWS")),
            patch(
                "apps.core.admin.service_credentials.test_send_mixin._send_test_sms",
                return_value="message (ID: m1)",
            ),
        ):
            self.admin.test_sms_list_view(request)
        self.assertTrue(any("Test SMS sent to +12065551234" in m for m in _messages(request)))

    def test_post_failure(self):
        request = _request(
            "post", self.user, {"country_code": "+1", "recipient": "2065551234"}, path="/admin/test-sms/"
        )
        with (
            patch.object(AWSCredentialConfig, "load", return_value=AWSCredentialConfig(name="AWS")),
            patch(
                "apps.core.admin.service_credentials.test_send_mixin._send_test_sms",
                side_effect=RuntimeError("sms boom"),
            ),
        ):
            self.admin.test_sms_list_view(request)
        self.assertTrue(any("Failed to send test SMS: sms boom" in m for m in _messages(request)))

    def test_action_redirect(self):
        request = _request("get", self.user, path="/admin/test-sms/")
        response = self.admin.test_sms_list(request)
        self.assertEqual(response.status_code, 302)
        self.assertIn("test-sms", response.url)


# ---------- aws credentials service ----------


class AwsCredentialsServiceTest(TestCase):
    def test_resolve_raises_when_unconfigured(self):
        from apps.core.services.aws.credentials import resolve_aws_credentials

        AWSCredentialConfig.objects.all().delete()
        with self.assertRaises(AwsCredentialsError):
            resolve_aws_credentials()

    def test_resolve_returns_credentials(self):
        from apps.core.services.aws.credentials import resolve_aws_credentials

        AWSCredentialConfig.objects.create(
            name="AWS", is_active=True, access_key_id="K", secret_access_key="S", default_region="eu-west-1"
        )
        creds = resolve_aws_credentials("ses")
        self.assertEqual(creds.access_key_id, "K")
        self.assertEqual(creds.region, "eu-west-1")

    def test_available_true_and_false(self):
        from apps.core.services.aws.credentials import aws_credentials_available

        AWSCredentialConfig.objects.all().delete()
        self.assertFalse(aws_credentials_available())
        AWSCredentialConfig.objects.create(name="AWS", is_active=True, access_key_id="K", secret_access_key="S")
        self.assertTrue(aws_credentials_available())
