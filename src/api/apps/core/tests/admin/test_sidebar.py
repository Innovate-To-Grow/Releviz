from django.conf import settings
from django.test import RequestFactory, SimpleTestCase, TestCase
from django.urls import NoReverseMatch, reverse

from apps.event.tests.helpers import make_superuser


class AdminSidebarNavigationTest(SimpleTestCase):
    def test_sidebar_navigation_starts_with_priority_groups(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        group_titles = [section["title"] for section in navigation]

        self.assertEqual(
            group_titles,
            [
                "Scheduling",
                "Email Delivery",
                "Members & Authentication",
                "Site Settings",
            ],
        )

    def test_sidebar_exposes_at_most_one_entry_for_each_tab_group(self):
        sidebar_links = []
        for section in settings.UNFOLD["SIDEBAR"]["navigation"]:
            for item in section["items"]:
                sidebar_links.append((section["title"], item["title"], item["link"]))

        for tab in settings.UNFOLD["TABS"]:
            tab_key = tab.get("page") or ", ".join(tab.get("models", []))
            tab_links = {item["link"] for item in tab["items"]}
            exposed_items = [
                (section_title, item_title, link)
                for section_title, item_title, link in sidebar_links
                if link in tab_links
            ]

            with self.subTest(tab=tab_key):
                self.assertLessEqual(
                    len(exposed_items),
                    1,
                    f"Tab group exposes multiple sidebar entries: {exposed_items}",
                )

    def test_site_settings_navigation_includes_groups_and_rsa_keys(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        site_settings_section = next(
            section for section in navigation if section["title"] == "Site Settings"
        )
        items_by_title = {item["title"]: item for item in site_settings_section["items"]}

        self.assertIn("Groups", items_by_title)
        self.assertIn("RSA Keypairs", items_by_title)
        self.assertEqual(items_by_title["Groups"]["link"], "/admin/auth/group/")
        self.assertEqual(items_by_title["RSA Keypairs"]["link"], "/admin/authn/rsakeypair/")

    def test_members_navigation_includes_auth_entries(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        members_section = next(
            section for section in navigation if section["title"] == "Members & Authentication"
        )
        item_titles = {item["title"] for item in members_section["items"]}

        self.assertIn("Members", item_titles)
        self.assertIn("Emails", item_titles)
        self.assertIn("Login Challenges", item_titles)

    def test_email_delivery_navigation_includes_providers_and_logs(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        email_section = next(
            section for section in navigation if section["title"] == "Email Delivery"
        )
        items_by_title = {item["title"]: item for item in email_section["items"]}

        self.assertIn("AWS SES Providers", items_by_title)
        self.assertIn("Email Logs", items_by_title)
        self.assertEqual(
            items_by_title["AWS SES Providers"]["link"], "/admin/mail/emailproviderconfig/"
        )
        self.assertEqual(
            items_by_title["Email Logs"]["link"], "/admin/mail/emailmessagelog/"
        )

    def test_scheduling_navigation_includes_event_participants_and_weights(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        scheduling_section = next(
            section for section in navigation if section["title"] == "Scheduling"
        )
        items_by_title = {item["title"]: item for item in scheduling_section["items"]}

        self.assertIn("Events", items_by_title)
        self.assertIn("Participants", items_by_title)
        self.assertIn("Weights", items_by_title)
        self.assertIn("Invitations", items_by_title)
        self.assertEqual(items_by_title["Events"]["link"], "/admin/scheduling/event/")
        self.assertEqual(items_by_title["Participants"]["link"], "/admin/scheduling/participant/")
        self.assertEqual(items_by_title["Weights"]["link"], "/admin/scheduling/weight/")
        self.assertEqual(
            items_by_title["Invitations"]["link"], "/admin/scheduling/eventinvitation/"
        )

    def test_scheduling_pages_are_grouped_under_tabs(self):
        tabs = settings.UNFOLD["TABS"]
        scheduling_tab = next(
            tab for tab in tabs if "scheduling.event" in tab.get("models", [])
        )

        self.assertEqual(
            scheduling_tab["models"],
            [
                "scheduling.event",
                "scheduling.participant",
                "scheduling.weight",
                "scheduling.userevent",
                "scheduling.eventinvitation",
            ],
        )
        self.assertEqual(
            scheduling_tab["items"],
            [
                {"title": "Events", "link": "/admin/scheduling/event/"},
                {"title": "Participants", "link": "/admin/scheduling/participant/"},
                {"title": "Weights", "link": "/admin/scheduling/weight/"},
                {"title": "User Events", "link": "/admin/scheduling/userevent/"},
                {"title": "Invitations", "link": "/admin/scheduling/eventinvitation/"},
            ],
        )

    def test_authn_pages_are_grouped_under_member_tabs(self):
        tabs = settings.UNFOLD["TABS"]
        members_tab = next(tab for tab in tabs if "authn.member" in tab.get("models", []))

        self.assertEqual(
            members_tab["models"],
            ["authn.member", "authn.contactemail"],
        )
        self.assertEqual(
            members_tab["items"],
            [
                {"title": "Members", "link": "/admin/authn/member/"},
                {"title": "Emails", "link": "/admin/authn/contactemail/"},
            ],
        )

    def test_mail_pages_are_grouped_under_email_delivery_tabs(self):
        tabs = settings.UNFOLD["TABS"]
        mail_tab = next(tab for tab in tabs if "mail.emailproviderconfig" in tab.get("models", []))

        self.assertEqual(
            mail_tab["models"],
            ["mail.emailproviderconfig", "mail.emailmessagelog"],
        )
        self.assertEqual(
            mail_tab["items"],
            [
                {"title": "Email Providers", "link": "/admin/mail/emailproviderconfig/"},
                {"title": "Email Logs", "link": "/admin/mail/emailmessagelog/"},
            ],
        )

    def test_no_stale_model_references_in_tabs(self):
        """Verify no tabs reference deleted models (gmailaccessaccount, etc.)."""
        tabs = settings.UNFOLD["TABS"]
        for tab in tabs:
            models_str = ", ".join(tab.get("models", []))
            self.assertNotIn("core.gmailaccessaccount", models_str)
            self.assertNotIn("core.emailserviceconfig", models_str)
            self.assertNotIn("core.googlecredentialconfig", models_str)
            self.assertNotIn("authn.membersheetsyncconfig", models_str)
            self.assertNotIn("authn.membersheetsynclog", models_str)

    def test_no_stale_model_references_in_sidebar(self):
        """Verify no sidebar items reference deleted model admin URLs."""
        all_links = set()
        for section in settings.UNFOLD["SIDEBAR"]["navigation"]:
            for item in section["items"]:
                all_links.add(item["link"])

        self.assertNotIn("/admin/core/emailserviceconfig/", all_links)
        self.assertNotIn("/admin/core/gmailaccessaccount/", all_links)
        self.assertNotIn("/admin/core/googlecredentialconfig/", all_links)
        self.assertNotIn("/admin/authn/membersheetsyncconfig/", all_links)
        self.assertNotIn("/admin/authn/membersheetsynclog/", all_links)


class AdminIndexNavigationTest(TestCase):
    def setUp(self):
        self.admin_user = make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_admin_index_uses_sidebar_navigation_groups(self):
        response = self.client.get(reverse("admin:index"))

        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "admin/index.html")
        self.assertContains(response, "Scheduling")
        self.assertContains(response, "Email Delivery")
        self.assertContains(response, "Members & Authentication")
        self.assertContains(response, "Site Settings")
        self.assertContains(response, "Events")
        self.assertContains(response, "Members")
        self.assertNotContains(response, "Models in the Administration application")

    def test_members_render_as_admin_tabs(self):
        url = reverse("admin:authn_member_changelist")
        response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'id="tabs-items"')
        self.assertContains(response, 'href="/admin/authn/member/"')

    def test_member_detail_pages_render_tabs(self):
        member_model = __import__("django.contrib.auth").contrib.auth.get_user_model()
        member = member_model.objects.create_user(
            email="member@example.com", password="testpass123"
        )

        url = reverse("admin:authn_member_change", args=[member.pk])
        response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'id="tabs-items"')

    def test_email_providers_page_render_as_admin_tabs(self):
        url = reverse("admin:mail_emailproviderconfig_changelist")
        response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'id="tabs-items"')
        self.assertContains(response, 'href="/admin/mail/emailproviderconfig/"')

    def test_scheduling_pages_render_as_admin_tabs(self):
        for url, active_href in (
            (reverse("admin:scheduling_event_changelist"), "/admin/scheduling/event/"),
            (reverse("admin:scheduling_participant_changelist"), "/admin/scheduling/participant/"),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)

                self.assertEqual(response.status_code, 200)
                self.assertContains(response, 'id="tabs-items"')
                self.assertContains(response, 'href="/admin/scheduling/event/"')
                self.assertContains(response, 'href="/admin/scheduling/participant/"')
                self.assertContains(response, f'href="{active_href}" class="active"')
