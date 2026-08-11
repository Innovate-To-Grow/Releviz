from pathlib import Path

from django.contrib.staticfiles import finders
from django.test import TestCase
from django.urls import reverse

from apps.cms.models import StyleSheet
from apps.core.models import SiteMaintenanceControl
from apps.event.tests.helpers import make_superuser
from apps.mail.models import EmailCampaign


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

        response = self.client.get(reverse("admin:core_sitemaintenancecontrol_change", args=[config.pk]))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "admin/js/material-web-text-field.js")
        self.assertContains(response, "md-outlined-text-field")

    def test_admin_base_loads_post_core_checkbox_overrides(self):
        config = SiteMaintenanceControl.objects.create(is_maintenance=False)

        response = self.client.get(reverse("admin:core_sitemaintenancecontrol_change", args=[config.pk]))
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
        self.assertIn("Core", html)
        self.assertNotIn("<caption", html)

    def test_enhancer_skips_specialized_admin_widgets(self):
        source = self._enhancer_source()

        self.assertIn('field.classList.contains("code-editor-field")', source)
        self.assertIn('field.name === "manual_emails"', source)
        self.assertIn("document.querySelector('input[name=\"body_format\"]')", source)
        self.assertIn('field.classList.contains("admin-autocomplete")', source)
        self.assertIn('field.tagName === "SELECT" && field.multiple', source)

    def test_stylesheet_code_editor_page_keeps_code_textarea_available(self):
        stylesheet = StyleSheet.objects.create(name="admin-test", display_name="Admin Test", css="body { color: red; }")

        response = self.client.get(reverse("admin:cms_stylesheet_change", args=[stylesheet.pk]))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "code-editor-field")
        self.assertContains(response, "admin/js/material-web-text-field.js")

    def test_email_campaign_editor_page_keeps_body_editor_hooks_available(self):
        campaign = EmailCampaign.objects.create(subject="Admin Test", body="<p>Hello</p>")

        response = self.client.get(reverse("admin:mail_emailcampaign_change", args=[campaign.pk]))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "mail/js/body_html_editor.js")
        self.assertContains(response, 'name="body_format"')
        self.assertContains(response, 'name="body"')
