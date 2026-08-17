from unittest.mock import patch

from django.apps import apps
from django.contrib import admin
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings

from apps.core.admin.service_credentials.aws import (
    AWSCredentialConfigAdmin,
    AWSCredentialConfigForm,
)
from apps.core.models import AWSCredentialConfig
from apps.core.services.aws.credentials import (
    AwsCredentialsError,
    aws_credentials_available,
    resolve_aws_credentials,
)
from apps.core.services.aws.crypto import decrypt_secret, encrypt_secret
from apps.core.tests.helpers import make_superuser


class AWSCredentialConfigAdminLabelsTests(SimpleTestCase):
    def test_admin_labels_match_site_settings_navigation(self):
        self.assertEqual(apps.get_app_config("core").verbose_name, "Site Settings")
        self.assertEqual(AWSCredentialConfig._meta.verbose_name, "AWS Credential")
        self.assertEqual(
            AWSCredentialConfig._meta.verbose_name_plural,
            "AWS Credentials",
        )


class AWSCredentialConfigAdminFormTests(TestCase):
    def test_secret_field_uses_unfold_password_styling(self):
        field = AWSCredentialConfigForm().fields["secret_access_key"]

        self.assertFalse(field.widget.render_value)
        self.assertEqual(field.widget.attrs["autocomplete"], "new-password")
        self.assertIn("w-full", field.widget.attrs["class"])
        self.assertIn("max-w-2xl", field.widget.attrs["class"])

    def test_blank_secret_keeps_existing_encrypted_value(self):
        credentials = AWSCredentialConfig.objects.create(
            name="Shared AWS",
            access_key_id="AKIATEST",
            default_region="us-west-2",
        )
        credentials.set_secret_access_key("existing-secret")
        credentials.save()

        form = AWSCredentialConfigForm(
            data={
                "name": credentials.name,
                "access_key_id": credentials.access_key_id,
                "default_region": credentials.default_region,
                "secret_access_key": "",
            },
            instance=credentials,
        )

        self.assertTrue(form.is_valid(), form.errors)
        saved = form.save()
        self.assertEqual(saved.get_secret_access_key(), "existing-secret")

    @override_settings(FIELD_ENCRYPTION_KEY="unit-test-encryption-key")
    def test_new_secret_is_encrypted_when_form_is_saved_without_commit(self):
        form = AWSCredentialConfigForm(
            data={
                "name": "Shared AWS",
                "is_active": False,
                "access_key_id": "AKIATEST",
                "default_region": "us-east-1",
                "secret_access_key": "new-secret",
            }
        )

        self.assertTrue(form.is_valid(), form.errors)
        credentials = form.save(commit=False)

        self.assertIsNone(credentials.pk)
        self.assertNotEqual(credentials.encrypted_secret_access_key, "new-secret")
        self.assertEqual(credentials.get_secret_access_key(), "new-secret")


@override_settings(FIELD_ENCRYPTION_KEY="unit-test-encryption-key")
class AWSCredentialConfigBehaviorTests(TestCase):
    def test_display_and_secret_helpers_cover_configured_and_empty_states(self):
        empty = AWSCredentialConfig(name="Empty", default_region="")
        self.assertEqual(str(empty), "Empty: empty")
        self.assertEqual(empty.region, "us-west-2")
        self.assertFalse(empty.is_configured)
        self.assertFalse(empty.ses_configured)

        empty.set_secret_access_key("")
        self.assertEqual(empty.encrypted_secret_access_key, "")

        configured = AWSCredentialConfig(
            name="Configured",
            access_key_id="AKIA12345678",
            default_region="eu-west-1",
            is_active=True,
        )
        configured.set_secret_access_key("secret")
        self.assertEqual(str(configured), "Configured: ...5678 (active)")
        self.assertTrue(configured.is_configured)
        self.assertTrue(configured.ses_configured)

    def test_load_returns_defaults_without_an_active_config(self):
        AWSCredentialConfig.objects.create(name="Inactive", is_active=False)

        loaded = AWSCredentialConfig.load()

        self.assertIsNone(loaded.pk)
        self.assertFalse(loaded.is_active)

    def test_activating_one_config_deactivates_the_previous_config(self):
        previous = AWSCredentialConfig.objects.create(name="Previous", is_active=True)
        current = AWSCredentialConfig.objects.create(name="Current", is_active=True)

        previous.refresh_from_db()
        self.assertFalse(previous.is_active)
        self.assertTrue(current.is_active)

    def test_crypto_handles_blank_and_invalid_ciphertext(self):
        self.assertEqual(encrypt_secret(""), "")
        self.assertEqual(decrypt_secret(""), "")
        self.assertEqual(decrypt_secret("not-a-valid-token"), "")

    def test_shared_credential_resolution_reports_availability(self):
        self.assertFalse(aws_credentials_available())
        with self.assertRaises(AwsCredentialsError):
            resolve_aws_credentials("ses")

        credentials = AWSCredentialConfig.objects.create(
            name="Active",
            access_key_id="AKIA12345678",
            default_region="ap-southeast-2",
            is_active=True,
        )
        credentials.set_secret_access_key("secret")
        credentials.save()

        self.assertTrue(aws_credentials_available())
        resolved = resolve_aws_credentials("ses")
        self.assertEqual(resolved.access_key_id, "AKIA12345678")
        self.assertEqual(resolved.secret_access_key, "secret")
        self.assertEqual(resolved.region, "ap-southeast-2")


class AWSCredentialConfigAdminBehaviorTests(TestCase):
    def setUp(self):
        self.model_admin = AWSCredentialConfigAdmin(AWSCredentialConfig, admin.site)

    @override_settings(FIELD_ENCRYPTION_KEY="unit-test-encryption-key")
    def test_badges_and_access_key_mask_cover_both_states(self):
        configured = AWSCredentialConfig(
            name="Configured", is_active=True, access_key_id="AKIA12345678"
        )
        configured.set_secret_access_key("secret")
        empty = AWSCredentialConfig(name="Empty")

        self.assertEqual(self.model_admin.status_badge(configured), ("Active", "success"))
        self.assertEqual(self.model_admin.status_badge(empty), ("Inactive", "danger"))
        self.assertEqual(self.model_admin.configured_badge(configured), ("Yes", "success"))
        self.assertEqual(self.model_admin.configured_badge(empty), ("No", "warning"))
        self.assertEqual(self.model_admin.access_key_masked(configured), "...5678")
        self.assertEqual(self.model_admin.access_key_masked(empty), "—")

    @patch("apps.core.admin.service_credentials.aws.messages.success")
    @patch("apps.core.admin.service_credentials.aws.cache.delete")
    def test_activate_action_activates_config_and_clears_usage_caches(self, cache_delete, success):
        credentials = AWSCredentialConfig.objects.create(name="Inactive")
        request = RequestFactory().post("/")

        response = self.model_admin.activate_this_config(request, credentials.pk)

        credentials.refresh_from_db()
        self.assertTrue(credentials.is_active)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(cache_delete.call_count, 2)
        success.assert_called_once()

    @patch("apps.core.admin.service_credentials.aws._clear_usage_dashboard_cache")
    @patch("apps.core.admin.common.base.BaseModelAdmin.save_model")
    def test_save_model_delegates_and_clears_usage_cache(self, save_model, clear_cache):
        request = RequestFactory().post("/")
        credentials = AWSCredentialConfig(name="Changed")

        self.model_admin.save_model(request, credentials, form=None, change=False)

        save_model.assert_called_once_with(request, credentials, None, False)
        clear_cache.assert_called_once_with()

    def test_active_config_cannot_be_deleted_but_inactive_config_can(self):
        request = RequestFactory().get("/")
        request.user = make_superuser()

        self.assertFalse(
            self.model_admin.has_delete_permission(
                request, AWSCredentialConfig(name="Active", is_active=True)
            )
        )
        self.assertTrue(
            self.model_admin.has_delete_permission(
                request, AWSCredentialConfig(name="Inactive", is_active=False)
            )
        )

    @patch("apps.core.admin.common.base.BaseModelAdmin.get_actions")
    def test_get_actions_forwards_location_and_removes_delete(self, get_actions):
        get_actions.return_value = {
            "delete_selected": (object(), "delete_selected", "Delete selected"),
            "keep": (object(), "keep", "Keep"),
        }
        request = RequestFactory().get("/")
        action_location = object()

        actions = self.model_admin.get_actions(
            request,
            action_location=action_location,
        )

        self.assertNotIn("delete_selected", actions)
        self.assertIn("keep", actions)
        get_actions.assert_called_once_with(
            request,
            action_location=action_location,
        )

    @patch("apps.core.admin.common.base.BaseModelAdmin.get_actions")
    def test_get_actions_without_location_removes_delete(self, get_actions):
        get_actions.return_value = {
            "delete_selected": (object(), "delete_selected", "Delete selected"),
            "keep": (object(), "keep", "Keep"),
        }
        request = RequestFactory().get("/")

        actions = self.model_admin.get_actions(request)

        self.assertNotIn("delete_selected", actions)
        self.assertIn("keep", actions)
        get_actions.assert_called_once_with(request)
