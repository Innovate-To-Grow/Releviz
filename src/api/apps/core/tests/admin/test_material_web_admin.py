from pathlib import Path

from django.contrib.staticfiles import finders
from django.test import TestCase
from django.urls import reverse

from apps.core.models import AWSCredentialConfig, SiteMaintenanceControl
from apps.core.tests.helpers import make_superuser
from apps.mail.models import EmailProviderConfig


class MaterialWebAdminEnhancerTests(TestCase):
    def setUp(self):
        self.admin_user = make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def _enhancer_source(self):
        path = finders.find("admin/js/material-web-text-field.js")
        self.assertIsNotNone(path)
        return Path(path).read_text()

    def test_admin_base_loads_material_web_enhancer(self):
        config = SiteMaintenanceControl.objects.create(is_maintenance=False)

        response = self.client.get(
            reverse("admin:core_sitemaintenancecontrol_change", args=[config.pk])
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "admin/js/material-web-text-field.js")
        self.assertContains(response, "md-outlined-text-field")

    def test_admin_base_loads_post_core_checkbox_overrides(self):
        config = SiteMaintenanceControl.objects.create(is_maintenance=False)

        response = self.client.get(
            reverse("admin:core_sitemaintenancecontrol_change", args=[config.pk])
        )
        html = response.content.decode()

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "admin/css/google-material-admin-overrides.css")
        self.assertLess(
            html.index("/static/unfold/css/styles.css"),
            html.index("/static/admin/css/google-material-admin-overrides.css"),
        )
        path = finders.find("admin/css/google-material-admin-overrides.css")
        self.assertIsNotNone(path)
        source = Path(path).read_text()
        self.assertIn("#changelist input.action-select:checked", source)

    def test_admin_app_list_renders_heading_outside_table_caption(self):
        response = self.client.get(reverse("admin:app_list", kwargs={"app_label": "core"}))
        html = response.content.decode()

        self.assertEqual(response.status_code, 200)
        self.assertIn("<h2", html)
        self.assertIn("Site Settings", html)
        self.assertNotIn("<caption", html)

    def test_enhancer_skips_specialized_admin_widgets(self):
        source = self._enhancer_source()

        self.assertIn('field.classList.contains("code-editor-field")', source)
        self.assertIn('field.name === "manual_emails"', source)
        self.assertIn("document.querySelector('input[name=\"body_format\"]')", source)
        self.assertIn('field.classList.contains("admin-autocomplete")', source)
        self.assertIn('field.tagName === "SELECT" && field.multiple', source)

    def test_aws_credential_page_keeps_password_widget_available(self):
        credentials = AWSCredentialConfig.objects.create(name="Admin Test")

        response = self.client.get(
            reverse("admin:core_awscredentialconfig_change", args=[credentials.pk])
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'name="secret_access_key"')
        self.assertContains(response, "admin/js/material-web-text-field.js")

    def test_email_provider_page_keeps_current_email_fields_available(self):
        provider = EmailProviderConfig.objects.create(
            name="Admin Test",
            is_active=False,
            from_email="sender@example.com",
        )

        response = self.client.get(
            reverse("admin:mail_emailproviderconfig_change", args=[provider.pk])
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'name="from_email"')
        self.assertContains(response, 'name="reply_to_email"')
        self.assertContains(response, "admin/js/material-web-text-field.js")
