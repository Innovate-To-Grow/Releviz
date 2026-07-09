from django.contrib.auth import get_user_model
from django.contrib.staticfiles import finders
from django.test import TestCase


class AdminThemeRenderingTests(TestCase):
    def test_admin_login_uses_scheduler_material_theme(self):
        response = self.client.get("/admin/login/?next=/admin/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Scheduler Admin")
        self.assertContains(response, "login-box")
        self.assertContains(response, "dark .login-box")
        self.assertContains(response, "/static/images/scheduler-logo")
        self.assertContains(response, ".svg")
        self.assertContains(response, "admin/css/google-material-admin.css")
        self.assertContains(response, "admin/js/i2g-admin-theme-runtime.js")
        self.assertContains(response, 'data-admin-theme-choice="dark"')
        self.assertContains(response, "Sign In")
        self.assertNotContains(response, "Innovate")
        self.assertNotContains(response, "I2G Home")

    def test_admin_index_uses_scheduler_material_theme_and_groups(self):
        admin = get_user_model().objects.create_superuser(
            email="admin@example.com",
            password="password123",
        )
        self.client.force_login(admin)

        response = self.client.get("/admin/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Scheduler")
        self.assertContains(response, "/static/images/scheduler-logo")
        self.assertContains(response, ".svg")
        self.assertContains(response, "admin/css/google-material-admin.css")
        self.assertContains(response, "admin/css/google-material-admin-overrides.css")
        self.assertContains(response, "admin/js/i2g-admin-theme-runtime.js")
        self.assertContains(response, "admin/js/material-web-text-field.js")
        self.assertContains(response, 'data-testid="i2g-admin-theme-toggle"')
        self.assertContains(response, 'data-admin-theme-choice="dark"')
        self.assertContains(response, "Scheduling")
        self.assertContains(response, "Members &amp; Authentication")
        self.assertContains(response, "Site Settings")
        self.assertNotContains(response, "Innovate")
        self.assertNotContains(response, "I2G Home")

    def test_admin_theme_static_assets_are_available(self):
        for path in [
            "images/scheduler-logo.svg",
            "admin/css/google-material-admin.css",
            "admin/css/google-material-admin-overrides.css",
            "admin/css/tabs.css",
            "admin/css/file-input.css",
            "admin/js/i2g-admin-theme-runtime.js",
            "admin/js/material-web-text-field.js",
        ]:
            with self.subTest(path=path):
                self.assertIsNotNone(finders.find(path))

    def test_material_theme_css_has_dark_mode_rules(self):
        css_path = finders.find("admin/css/google-material-admin.css")
        self.assertIsNotNone(css_path)

        with open(css_path, encoding="utf-8") as css_file:
            css = css_file.read()

        self.assertIn(".dark", css)
        self.assertIn("--md-sys-color-primary", css)
        self.assertIn(".dark .text-font-default-light", css)
