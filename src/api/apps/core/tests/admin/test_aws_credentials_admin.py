from django.apps import apps
from django.test import SimpleTestCase, TestCase

from apps.core.admin.service_credentials.aws import AWSCredentialConfigForm
from apps.core.models import AWSCredentialConfig


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
