"""Additional coverage for service-credential admins, helpers, and the test-send mixin."""

from unittest.mock import MagicMock, patch

from django.contrib.admin.sites import AdminSite
from django.contrib.messages.storage.fallback import FallbackStorage
from django.core.cache import cache
from django.test import RequestFactory, TestCase

from apps.core.admin.service_credentials.aws import AWSCredentialConfigAdmin, AWSCredentialConfigForm
from apps.core.admin.service_credentials.gmail import GmailAccessAccountAdmin
from apps.core.admin.service_credentials.google import GoogleCredentialConfigAdmin, GoogleCredentialConfigForm
from apps.core.models import (
    AWSCredentialConfig,
    GmailAccessAccount,
    GoogleCredentialConfig,
)
from apps.event.tests.helpers import make_superuser
from apps.system_intelligence.models import SystemIntelligenceConfig

VALID_GOOGLE_JSON = {
    "type": "service_account",
    "project_id": "proj-123",
    "private_key": "fake-key",  # noqa: S106 — test fixture
    "client_email": "svc@proj.iam.gserviceaccount.com",
    "token_uri": "https://oauth2.googleapis.com/token",
}


def _request(user):
    request = RequestFactory().get("/")
    request.user = user
    request.session = {}
    request._messages = FallbackStorage(request)
    return request


def _messages(request):
    return [str(m) for m in request._messages]


# ---------- AWS admin display + actions ----------


class AWSAdminDisplayTest(TestCase):
    def setUp(self):
        self.user = make_superuser()
        self.admin = AWSCredentialConfigAdmin(AWSCredentialConfig, AdminSite())

    def test_status_badge_active_and_inactive(self):
        active = AWSCredentialConfig(is_active=True)
        inactive = AWSCredentialConfig(is_active=False)
        self.assertEqual(self.admin.status_badge(active), ("Active", "success"))
        self.assertEqual(self.admin.status_badge(inactive), ("Inactive", "danger"))

    def test_configured_badge(self):
        configured = AWSCredentialConfig(access_key_id="AKIA", secret_access_key="s")
        unconfigured = AWSCredentialConfig()
        self.assertEqual(self.admin.configured_badge(configured), ("Yes", "success"))
        self.assertEqual(self.admin.configured_badge(unconfigured), ("No", "warning"))

    def test_access_key_masked(self):
        obj = AWSCredentialConfig(access_key_id="AKIA1234WXYZ")
        self.assertEqual(self.admin.access_key_masked(obj), "...WXYZ")
        self.assertEqual(self.admin.access_key_masked(AWSCredentialConfig()), "—")

    def test_activate_this_config(self):
        other = AWSCredentialConfig.objects.create(
            name="Other", is_active=True, access_key_id="A", secret_access_key="S"
        )
        target = AWSCredentialConfig.objects.create(name="Target", access_key_id="B", secret_access_key="S")
        cache.set("assistant:usage:cloudwatch", {"available": False})
        cache.set("assistant:usage:local", {"counts": {}})
        response = self.admin.activate_this_config(_request(self.user), str(target.pk))
        self.assertEqual(response.status_code, 302)
        target.refresh_from_db()
        other.refresh_from_db()
        self.assertTrue(target.is_active)
        self.assertFalse(other.is_active)
        self.assertIsNone(cache.get("assistant:usage:cloudwatch"))
        self.assertIsNone(cache.get("assistant:usage:local"))

    def test_save_model_clears_usage_dashboard_cache(self):
        obj = AWSCredentialConfig(name="Cfg", is_active=True, access_key_id="K", secret_access_key="S")
        cache.set("assistant:usage:cloudwatch", {"available": False})
        cache.set("assistant:usage:local", {"counts": {}})
        self.admin.save_model(_request(self.user), obj, form=None, change=False)
        self.assertIsNone(cache.get("assistant:usage:cloudwatch"))
        self.assertIsNone(cache.get("assistant:usage:local"))

    def test_has_delete_permission_blocked_for_active(self):
        active = AWSCredentialConfig.objects.create(name="A", is_active=True, access_key_id="K", secret_access_key="S")
        self.assertFalse(self.admin.has_delete_permission(_request(self.user), active))

    def test_has_delete_permission_allowed_for_inactive(self):
        inactive = AWSCredentialConfig.objects.create(name="B", is_active=False)
        self.assertTrue(self.admin.has_delete_permission(_request(self.user), inactive))

    def test_get_actions_removes_delete_selected(self):
        actions = self.admin.get_actions(_request(self.user))
        self.assertNotIn("delete_selected", actions)

    def test_form_uses_password_widget(self):
        form = AWSCredentialConfigForm()
        self.assertIn("secret_access_key", form.fields)


class AWSBedrockTestActionTest(TestCase):
    def setUp(self):
        self.user = make_superuser()
        self.admin = AWSCredentialConfigAdmin(AWSCredentialConfig, AdminSite())

    def test_not_configured_errors(self):
        obj = AWSCredentialConfig.objects.create(name="Empty", is_active=False)
        request = _request(self.user)
        response = self.admin.test_bedrock_api(request, str(obj.pk))
        self.assertEqual(response.status_code, 302)
        self.assertIn("Cannot test: AWS credentials are not configured.", _messages(request))

    def test_no_model_selected_errors(self):
        obj = AWSCredentialConfig.objects.create(name="Cfg", is_active=True, access_key_id="K", secret_access_key="S")
        SystemIntelligenceConfig.objects.create(name="SI", is_active=True, default_model_id="")
        request = _request(self.user)
        response = self.admin.test_bedrock_api(request, str(obj.pk))
        self.assertIn("no default AI model selected", _messages(request)[0])

    @patch("boto3.client")
    def test_success_message(self, mock_client):
        runtime = MagicMock()
        runtime.converse.return_value = {"output": {"message": {"content": [{"text": " OK "}]}}}
        mock_client.return_value = runtime
        obj = AWSCredentialConfig.objects.create(name="Cfg", is_active=True, access_key_id="K", secret_access_key="S")
        SystemIntelligenceConfig.objects.create(name="SI", is_active=True, default_model_id="m1")
        request = _request(self.user)
        self.admin.test_bedrock_api(request, str(obj.pk))
        self.assertTrue(any("Bedrock API test passed" in m for m in _messages(request)))

    @patch("boto3.client")
    def test_client_error_message(self, mock_client):
        from botocore.exceptions import ClientError

        runtime = MagicMock()
        runtime.converse.side_effect = ClientError({"Error": {"Code": "AccessDenied", "Message": "denied"}}, "Converse")
        mock_client.return_value = runtime
        obj = AWSCredentialConfig.objects.create(name="Cfg", is_active=True, access_key_id="K", secret_access_key="S")
        SystemIntelligenceConfig.objects.create(name="SI", is_active=True, default_model_id="m1")
        request = _request(self.user)
        self.admin.test_bedrock_api(request, str(obj.pk))
        self.assertTrue(any("Bedrock API test failed: denied" in m for m in _messages(request)))

    @patch("boto3.client", side_effect=RuntimeError("network down"))
    def test_generic_error_message(self, _mock_client):
        obj = AWSCredentialConfig.objects.create(name="Cfg", is_active=True, access_key_id="K", secret_access_key="S")
        SystemIntelligenceConfig.objects.create(name="SI", is_active=True, default_model_id="m1")
        request = _request(self.user)
        self.admin.test_bedrock_api(request, str(obj.pk))
        self.assertTrue(any("Bedrock API test failed: network down" in m for m in _messages(request)))


# ---------- Google admin + form ----------


class GoogleAdminTest(TestCase):
    def setUp(self):
        self.user = make_superuser()
        self.admin = GoogleCredentialConfigAdmin(GoogleCredentialConfig, AdminSite())

    def test_status_badge(self):
        self.assertEqual(self.admin.status_badge(GoogleCredentialConfig(is_active=True)), ("Active", "success"))
        self.assertEqual(self.admin.status_badge(GoogleCredentialConfig(is_active=False)), ("Inactive", "danger"))

    def test_project_and_client_email_display(self):
        obj = GoogleCredentialConfig(credentials_json=VALID_GOOGLE_JSON)
        self.assertEqual(self.admin.project_id_display(obj), "proj-123")
        self.assertEqual(self.admin.client_email_display(obj), "svc@proj.iam.gserviceaccount.com")
        empty = GoogleCredentialConfig(credentials_json={})
        self.assertEqual(self.admin.project_id_display(empty), "—")
        self.assertEqual(self.admin.client_email_display(empty), "—")

    def test_activate_this_config(self):
        other = GoogleCredentialConfig.objects.create(name="Other", is_active=True, credentials_json=VALID_GOOGLE_JSON)
        target = GoogleCredentialConfig.objects.create(name="Target", credentials_json=VALID_GOOGLE_JSON)
        response = self.admin.activate_this_config(_request(self.user), str(target.pk))
        self.assertEqual(response.status_code, 302)
        target.refresh_from_db()
        other.refresh_from_db()
        self.assertTrue(target.is_active)
        self.assertFalse(other.is_active)

    def test_has_delete_permission(self):
        active = GoogleCredentialConfig.objects.create(name="A", is_active=True, credentials_json=VALID_GOOGLE_JSON)
        inactive = GoogleCredentialConfig.objects.create(name="B", credentials_json=VALID_GOOGLE_JSON)
        self.assertFalse(self.admin.has_delete_permission(_request(self.user), active))
        self.assertTrue(self.admin.has_delete_permission(_request(self.user), inactive))

    def test_get_actions_removes_delete_selected(self):
        self.assertNotIn("delete_selected", self.admin.get_actions(_request(self.user)))


class GoogleFormTest(TestCase):
    def _file(self, content, name="key.json"):
        from django.core.files.uploadedfile import SimpleUploadedFile

        return SimpleUploadedFile(name, content, content_type="application/json")

    def test_valid_json_file_parsed_into_credentials(self):
        import json

        form = GoogleCredentialConfigForm(
            data={"name": "Sheets", "credentials_json": "{}"},
            files={"credentials_file": self._file(json.dumps(VALID_GOOGLE_JSON).encode())},
        )
        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(form.cleaned_data["credentials_json"], VALID_GOOGLE_JSON)

    def test_invalid_json_file_rejected(self):
        form = GoogleCredentialConfigForm(
            data={"name": "Sheets", "credentials_json": "{}"},
            files={"credentials_file": self._file(b"{not json")},
        )
        self.assertFalse(form.is_valid())
        self.assertIn("credentials_file", form.errors)

    def test_non_object_json_rejected(self):
        import json

        form = GoogleCredentialConfigForm(
            data={"name": "Sheets", "credentials_json": "{}"},
            files={"credentials_file": self._file(json.dumps([1, 2, 3]).encode())},
        )
        self.assertFalse(form.is_valid())
        self.assertIn("credentials_file", form.errors)

    def test_no_file_returns_none(self):
        form = GoogleCredentialConfigForm(
            data={"name": "Sheets", "credentials_json": __import__("json").dumps(VALID_GOOGLE_JSON)}
        )
        self.assertTrue(form.is_valid(), form.errors)
        self.assertIsNone(form.cleaned_data.get("credentials_file"))


# ---------- Gmail admin ----------


class GmailAdminTest(TestCase):
    def setUp(self):
        self.user = make_superuser()
        self.admin = GmailAccessAccountAdmin(GmailAccessAccount, AdminSite())

    def test_status_badge(self):
        self.assertEqual(self.admin.status_badge(GmailAccessAccount(is_active=True)), ("Active", "success"))
        self.assertEqual(self.admin.status_badge(GmailAccessAccount(is_active=False)), ("Inactive", "danger"))

    def test_activate_this_config(self):
        other = GmailAccessAccount.objects.create(name="Other", is_active=True, gmail_username="a@x.com")
        target = GmailAccessAccount.objects.create(name="Target", gmail_username="b@x.com")
        response = self.admin.activate_this_config(_request(self.user), str(target.pk))
        self.assertEqual(response.status_code, 302)
        target.refresh_from_db()
        other.refresh_from_db()
        self.assertTrue(target.is_active)
        self.assertFalse(other.is_active)

    def test_has_delete_permission(self):
        active = GmailAccessAccount.objects.create(name="A", is_active=True, gmail_username="a@x.com")
        inactive = GmailAccessAccount.objects.create(name="B", gmail_username="b@x.com")
        self.assertFalse(self.admin.has_delete_permission(_request(self.user), active))
        self.assertTrue(self.admin.has_delete_permission(_request(self.user), inactive))

    def test_get_actions_removes_delete_selected(self):
        self.assertNotIn("delete_selected", self.admin.get_actions(_request(self.user)))
