from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.staticfiles import finders
from django.test import RequestFactory, TestCase

from apps.core.admin_site import RelevizAdminSite, select_current_sidebar_item


class AdminThemeRenderingTests(TestCase):
    def test_admin_login_uses_releviz_material_theme(self):
        response = self.client.get("/admin/login/?next=/admin/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Releviz Admin")
        self.assertContains(response, "login-box")
        self.assertContains(response, "dark .login-box")
        self.assertContains(response, "/static/images/releviz-mark.png")
        self.assertContains(response, "admin/css/google-material-admin.css")
        self.assertContains(response, "admin/js/i2g-admin-theme-runtime.js")
        self.assertContains(response, 'data-admin-theme-choice="dark"')
        self.assertContains(response, "Sign In")
        self.assertNotContains(response, "Innovate")
        self.assertNotContains(response, "I2G Home")

    def test_admin_index_uses_releviz_material_theme_and_groups(self):
        admin = get_user_model().objects.create_superuser(
            email="admin@example.com",
            password="password123",
        )
        self.client.force_login(admin)

        response = self.client.get("/admin/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Releviz")
        self.assertContains(response, "/static/images/releviz-mark.png")
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

    def test_admin_sidebar_selects_only_the_current_model(self):
        admin_user = get_user_model().objects.create_superuser(
            email="admin@example.com",
            password="password123",
        )
        routes = [
            ("/admin/scheduling/event/", "Events"),
            ("/admin/scheduling/event/1/change/", "Events"),
            ("/admin/scheduling/participant/", "Participants"),
            ("/admin/scheduling/weight/", "Weights"),
            ("/admin/scheduling/eventinvitation/", "Invitations"),
            ("/admin/messaging/emailproviderconfig/", "AWS SES Providers"),
            ("/admin/messaging/emailproviderconfig/add/", "AWS SES Providers"),
            ("/admin/messaging/emailmessagelog/", "Email Logs"),
            ("/admin/authn/member/", "Members"),
            ("/admin/authn/contactemail/", "Emails & Phones"),
            ("/admin/authn/contactphone/", "Emails & Phones"),
            ("/admin/authn/emailauthchallenge/", "Login Challenges"),
            ("/admin/auth/group/", "Groups"),
            ("/admin/authn/rsakeypair/", "RSA Keypairs"),
        ]

        self.assertIsInstance(admin.site, RelevizAdminSite)

        for path, expected_title in routes:
            with self.subTest(path=path):
                request = RequestFactory().get(path)
                request.user = admin_user
                navigation = admin.site.get_sidebar_list(request)
                active_titles = [
                    str(item["title"])
                    for group in navigation
                    for item in group["items"]
                    if item.get("active")
                ]

                self.assertEqual(active_titles, [expected_title])

    def test_admin_sidebar_selection_normalizes_custom_and_nested_items(self):
        navigation = [
            {
                "items": [
                    {"title": "No link", "link": None, "active": True},
                    {"title": "Fragment", "link": "#details", "active": True},
                    {
                        "title": "Hidden",
                        "link": "/admin/example/record/",
                        "has_permission": False,
                        "active": True,
                    },
                    {"title": "Record", "link": "/admin/example/record/", "active": True},
                    {
                        "title": "Example",
                        "active_paths": "/admin/example/",
                        "active": True,
                    },
                    {
                        "title": "Parent",
                        "link": "/admin/other/",
                        "active": True,
                        "items": [
                            {
                                "title": "Nested",
                                "link": "/admin/other/nested/",
                                "active": True,
                            }
                        ],
                    },
                ]
            }
        ]

        select_current_sidebar_item(navigation, "/admin/example/record/")

        active_titles = [
            str(item["title"])
            for group in navigation
            for item in group["items"]
            if item.get("active")
        ]
        self.assertEqual(active_titles, ["Record"])
        self.assertFalse(navigation[0]["items"][-1]["items"][0]["active"])

    def test_admin_theme_static_assets_are_available(self):
        for path in [
            "images/releviz-mark.png",
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
