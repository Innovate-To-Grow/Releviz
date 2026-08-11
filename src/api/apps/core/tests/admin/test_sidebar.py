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
                "Content Management System",
                "Events",
                "Projects",
                "Members & Authentication",
                "Broadcast Delivery",
                "System Intelligence",
                "Site Settings",
                "CLI Admin",
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

    def test_site_settings_navigation_includes_core_entries(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        site_settings_section = next(section for section in navigation if section["title"] == "Site Settings")
        items_by_title = {item["title"]: item for item in site_settings_section["items"]}

        self.assertIn("Site Maintenance Control", items_by_title)
        self.assertIn("Service Credentials", items_by_title)
        self.assertNotIn("System Intelligence", items_by_title)
        self.assertEqual(items_by_title["Site Maintenance Control"]["link"], "/admin/core/sitemaintenancecontrol/")
        self.assertEqual(items_by_title["Service Credentials"]["link"], "/admin/core/awscredentialconfig/")
        self.assertNotIn("Service Configs", items_by_title)

    def test_content_navigation_prioritizes_editing_before_analytics(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        content_section = next(section for section in navigation if section["title"] == "Content Management System")
        items_by_title = {item["title"]: item for item in content_section["items"]}

        self.assertEqual(items_by_title["Page Content"]["link"], "/admin/cms/cmspage/")
        self.assertEqual(items_by_title["Route Redirects"]["link"], "/admin/cms/routeredirect/")
        self.assertEqual(items_by_title["News Management"]["link"], "/admin/cms/newsarticle/")
        self.assertEqual(items_by_title["Page Analytics"]["link"], "/admin/cms/pageview/")

    def test_events_and_projects_navigation_keeps_existing_names(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        events_section = next(section for section in navigation if section["title"] == "Events")
        projects_section = next(section for section in navigation if section["title"] == "Projects")
        event_items_by_title = {item["title"]: item for item in events_section["items"]}
        project_items_by_title = {item["title"]: item for item in projects_section["items"]}

        self.assertEqual(event_items_by_title["Events & Registrations"]["link"], "/admin/event/event/")
        self.assertEqual(
            event_items_by_title["Current Projects & Schedule"]["link"], "/admin/event/currentprojectschedule/"
        )
        self.assertEqual(project_items_by_title["Projects"]["link"], "/admin/projects/project/")
        self.assertEqual(
            project_items_by_title["Project Resources"]["link"], "/admin/projects/pastprojectssheetconfig/"
        )
        self.assertNotIn("Past Projects", project_items_by_title)
        self.assertNotIn("Past Projects Sheet", project_items_by_title)
        self.assertNotIn("Semesters", project_items_by_title)

    def test_project_pages_are_grouped_under_project_tabs(self):
        tabs = settings.UNFOLD["TABS"]
        projects_tab = next(tab for tab in tabs if "projects.project" in tab.get("models", []))
        project_resources_tab = next(tab for tab in tabs if "projects.pastprojectssheetconfig" in tab.get("models", []))

        self.assertEqual(projects_tab["models"], ["projects.project", "projects.semester"])
        self.assertEqual(
            projects_tab["items"],
            [
                {"title": "Projects", "link": "/admin/projects/project/"},
                {"title": "Semesters", "link": "/admin/projects/semester/"},
            ],
        )
        self.assertEqual(
            project_resources_tab["models"],
            [
                "projects.pastprojectssheetconfig",
                "projects.pastprojectsynclog",
            ],
        )
        self.assertEqual(
            project_resources_tab["items"],
            [
                {"title": "Project Resources", "link": "/admin/projects/pastprojectssheetconfig/"},
                {"title": "Project Resource Sync Logs", "link": "/admin/projects/pastprojectsynclog/"},
            ],
        )

    def test_system_intelligence_navigation_includes_chat_and_settings(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        system_intelligence_section = next(
            section for section in navigation if section["title"] == "System Intelligence"
        )
        items_by_title = {item["title"]: item for item in system_intelligence_section["items"]}

        self.assertEqual(items_by_title["Chat"]["link"], "/admin/system-intelligence/")
        self.assertEqual(
            items_by_title["Assistant Tools"]["link"],
            "/admin/system_intelligence/systemintelligenceconfig/",
        )
        self.assertNotIn("Assistant Settings", items_by_title)
        self.assertNotIn("Usage Dashboard", items_by_title)
        self.assertNotIn("Conversation Logs", items_by_title)

    def test_system_intelligence_chat_sidebar_active_state_is_exact(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        system_intelligence_section = next(
            section for section in navigation if section["title"] == "System Intelligence"
        )
        items_by_title = {item["title"]: item for item in system_intelligence_section["items"]}
        factory = RequestFactory()

        chat_request = factory.get("/admin/system-intelligence/")
        usage_request = factory.get("/admin/system-intelligence/usage/")

        self.assertTrue(items_by_title["Chat"]["active"](chat_request))
        self.assertFalse(items_by_title["Chat"]["active"](usage_request))

    def test_system_intelligence_admin_pages_are_grouped_under_assistant_tabs(self):
        tabs = settings.UNFOLD["TABS"]
        model_tab = next(tab for tab in tabs if "system_intelligence.systemintelligenceconfig" in tab.get("models", []))
        page_tab = next(tab for tab in tabs if tab.get("page") == "system_intelligence_assistant_tools")

        expected_items = [
            {"title": "Assistant Settings", "link": "/admin/system_intelligence/systemintelligenceconfig/"},
            {"title": "Usage Dashboard", "link": "/admin/system-intelligence/usage/"},
            {"title": "Conversation Logs", "link": "/admin/system_intelligence/assistantconversationlog/"},
        ]

        self.assertEqual(
            model_tab["models"],
            [
                "system_intelligence.systemintelligenceconfig",
                "system_intelligence.assistantconversationlog",
            ],
        )
        self.assertEqual(model_tab["items"], expected_items)
        self.assertEqual(page_tab["items"], expected_items)

    def test_members_navigation_includes_auth_entries(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        members_section = next(section for section in navigation if section["title"] == "Members & Authentication")
        item_titles = {item["title"] for item in members_section["items"]}

        self.assertIn("Members", item_titles)
        self.assertIn("Emails & Phones", item_titles)
        self.assertIn("Admin Invitations", item_titles)
        self.assertNotIn("Emails", item_titles)
        self.assertNotIn("Phones", item_titles)
        self.assertNotIn("Member Sheet Sync", item_titles)
        self.assertNotIn("Contact Info", item_titles)

    def test_mail_navigation_includes_settings_and_tools(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        mail_section = next(section for section in navigation if section["title"] == "Broadcast Delivery")
        items_by_title = {item["title"]: item for item in mail_section["items"]}

        self.assertEqual(items_by_title["Delivery Operations"]["link"], "/admin/mail/delivery-dashboard/")
        self.assertEqual(items_by_title["Gmail Inbox"]["link"], "/admin/mail/inbox/")
        self.assertEqual(items_by_title["Broadcast Campaigns"]["link"], "/admin/mail/emailcampaign/")
        self.assertNotIn("Delivery Status & Settings", items_by_title)
        self.assertNotIn("Delivery Dashboard", items_by_title)
        self.assertNotIn("Notification Delivery", items_by_title)
        self.assertNotIn("Broadcast Email", items_by_title)
        self.assertNotIn("Broadcast SMS", items_by_title)
        self.assertNotIn("Scam Detection", items_by_title)

    def test_mail_delivery_operations_sidebar_active_state_includes_dashboard_and_settings(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        mail_section = next(section for section in navigation if section["title"] == "Broadcast Delivery")
        items_by_title = {item["title"]: item for item in mail_section["items"]}
        factory = RequestFactory()

        dashboard_request = factory.get("/admin/mail/delivery-dashboard/")
        settings_request = factory.get("/admin/mail/settings/")
        inbox_request = factory.get("/admin/mail/inbox/")

        self.assertTrue(items_by_title["Delivery Operations"]["active"](dashboard_request))
        self.assertTrue(items_by_title["Delivery Operations"]["active"](settings_request))
        self.assertFalse(items_by_title["Delivery Operations"]["active"](inbox_request))

    def test_mail_delivery_operations_pages_are_grouped_under_tabs(self):
        tabs = settings.UNFOLD["TABS"]
        delivery_tab = next(tab for tab in tabs if tab.get("page") == "mail_delivery_operations")

        self.assertEqual(
            delivery_tab["items"],
            [
                {"title": "Delivery Dashboard", "link": "/admin/mail/delivery-dashboard/"},
                {"title": "Notification Delivery", "link": "/admin/mail/settings/"},
            ],
        )

    def test_service_config_tabs_exclude_standalone_mail_settings(self):
        tabs = settings.UNFOLD["TABS"]
        service_config_tab = next(tab for tab in tabs if "core.gmailaccessaccount" in tab["models"])
        item_titles = {item["title"] for item in service_config_tab["items"]}

        self.assertNotIn("system_intelligence.systemintelligenceconfig", service_config_tab["models"])
        self.assertNotIn("core.emailserviceconfig", service_config_tab["models"])
        self.assertNotIn("core.smsserviceconfig", service_config_tab["models"])
        self.assertNotIn("System Intelligence Config", item_titles)
        self.assertNotIn("Notification Delivery", item_titles)
        self.assertIn("Gmail Access Account", item_titles)
        self.assertNotIn("SMS Config", item_titles)
        self.assertIn("Google Credentials", item_titles)
        self.assertIn("AWS Credentials", item_titles)

    def test_mail_settings_route_is_registered_under_mail_app(self):
        self.assertEqual(reverse("admin:mail_delivery_dashboard"), "/admin/mail/delivery-dashboard/")
        self.assertEqual(reverse("admin:mail_delivery_dashboard_data"), "/admin/mail/delivery-dashboard/data/")
        self.assertEqual(reverse("admin:mail_settings"), "/admin/mail/settings/")
        self.assertEqual(reverse("admin:mail_smscampaign_changelist"), "/admin/mail/smscampaign/")
        with self.assertRaises(NoReverseMatch):
            reverse("admin:core_emailserviceconfig_changelist")
        with self.assertRaises(NoReverseMatch):
            reverse("admin:mail_scamdetectorconfig_changelist")

    def test_cli_admin_navigation_uses_access_and_audit_group_entry(self):
        navigation = settings.UNFOLD["SIDEBAR"]["navigation"]
        cli_admin_section = next(section for section in navigation if section["title"] == "CLI Admin")
        items_by_title = {item["title"]: item for item in cli_admin_section["items"]}

        self.assertEqual(items_by_title["CLI Access & Audit"]["link"], "/admin/cli_admin/cliaccesstoken/")
        self.assertNotIn("Access & Audit", items_by_title)
        self.assertNotIn("Access Tokens", items_by_title)
        self.assertNotIn("Authorization Codes", items_by_title)
        self.assertNotIn("Audit Log", items_by_title)

    def test_cli_admin_pages_are_grouped_under_access_token_tabs(self):
        tabs = settings.UNFOLD["TABS"]
        cli_admin_tab = next(tab for tab in tabs if "cli_admin.cliaccesstoken" in tab.get("models", []))

        self.assertEqual(
            cli_admin_tab["models"],
            [
                "cli_admin.cliaccesstoken",
                "cli_admin.cliauthorizationcode",
                "cli_admin.cliauditlog",
            ],
        )
        self.assertEqual(
            cli_admin_tab["items"],
            [
                {"title": "Access Tokens", "link": "/admin/cli_admin/cliaccesstoken/"},
                {"title": "Authorization Codes", "link": "/admin/cli_admin/cliauthorizationcode/"},
                {"title": "Audit Log", "link": "/admin/cli_admin/cliauditlog/"},
            ],
        )


class AdminIndexNavigationTest(TestCase):
    def setUp(self):
        self.admin_user = make_superuser()
        self.client.login(username="admin@example.com", password="testpass123")

    def test_admin_index_uses_sidebar_navigation_groups(self):
        response = self.client.get(reverse("admin:index"))

        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "admin/index.html")
        self.assertContains(response, "Content Management System")
        self.assertContains(response, "Page Content")
        self.assertContains(response, "Site Settings")
        self.assertContains(response, "Site Maintenance Control")
        self.assertContains(response, "Page Analytics")
        self.assertContains(response, 'href="/admin/system-intelligence/"')
        self.assertNotContains(response, "Models in the Administration application")

    def test_members_render_as_admin_tabs(self):
        url = reverse("admin:authn_member_changelist")
        active_href = "/admin/authn/member/"
        response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'id="tabs-items"')
        self.assertContains(response, 'href="/admin/authn/member/"')

    def test_mail_delivery_operations_render_as_admin_tabs(self):
        for url, active_href in (
            (reverse("admin:mail_delivery_dashboard"), "/admin/mail/delivery-dashboard/"),
            (reverse("admin:mail_settings"), "/admin/mail/settings/"),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)

                self.assertEqual(response.status_code, 200)
                self.assertContains(response, 'id="tabs-items"')
                self.assertContains(response, 'href="/admin/mail/delivery-dashboard/"')
                self.assertContains(response, 'href="/admin/mail/settings/"')
                self.assertContains(response, f'href="{active_href}" class="active"')

        response = self.client.get(reverse("admin:mail_delivery_dashboard"))
        html = response.content.decode()
        sidebar_html = html.split('<div id="main"', maxsplit=1)[0]
        broadcast_sidebar_html = sidebar_html.rsplit("Broadcast Delivery", maxsplit=1)[-1].split(
            "System Intelligence", maxsplit=1
        )[0]
        self.assertIn("Delivery Operations", broadcast_sidebar_html)
        self.assertNotIn("Delivery Status & Settings", broadcast_sidebar_html)
        self.assertNotIn("Delivery Dashboard", broadcast_sidebar_html)
        self.assertNotIn("Notification Delivery", broadcast_sidebar_html)

    def test_projects_and_semesters_render_as_admin_tabs(self):
        for url, active_href in (
            (reverse("admin:projects_project_changelist"), "/admin/projects/project/"),
            (reverse("admin:projects_semester_changelist"), "/admin/projects/semester/"),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)

                self.assertEqual(response.status_code, 200)
                self.assertContains(response, 'id="tabs-items"')
                self.assertContains(response, 'href="/admin/projects/project/"')
                self.assertContains(response, 'href="/admin/projects/semester/"')
                self.assertContains(response, f'href="{active_href}" class="active"')

        response = self.client.get(reverse("admin:projects_project_changelist"))
        html = response.content.decode()
        sidebar_html = html.split('<div id="main"', maxsplit=1)[0]
        self.assertNotIn("Semesters", sidebar_html)

    def test_project_resource_models_render_as_admin_tabs(self):
        for url, active_href in (
            (reverse("admin:projects_pastprojectssheetconfig_changelist"), "/admin/projects/pastprojectssheetconfig/"),
            (reverse("admin:projects_pastprojectsynclog_changelist"), "/admin/projects/pastprojectsynclog/"),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)

                self.assertEqual(response.status_code, 200)
                self.assertContains(response, 'id="tabs-items"')
                self.assertContains(response, 'href="/admin/projects/pastprojectssheetconfig/"')
                self.assertContains(response, 'href="/admin/projects/pastprojectsynclog/"')
                self.assertContains(response, f'href="{active_href}" class="active"')

    def test_system_intelligence_model_pages_render_as_admin_tabs(self):
        for url, active_href in (
            (
                reverse("admin:system_intelligence_systemintelligenceconfig_changelist"),
                "/admin/system_intelligence/systemintelligenceconfig/",
            ),
            (
                reverse("admin:system_intelligence_assistantconversationlog_changelist"),
                "/admin/system_intelligence/assistantconversationlog/",
            ),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)

                self.assertEqual(response.status_code, 200)
                self.assertContains(response, 'id="tabs-items"')
                self.assertContains(response, 'href="/admin/system_intelligence/systemintelligenceconfig/"')
                self.assertContains(response, 'href="/admin/system-intelligence/usage/"')
                self.assertContains(response, 'href="/admin/system_intelligence/assistantconversationlog/"')
                self.assertContains(response, f'href="{active_href}" class="active"')

        response = self.client.get(reverse("admin:system_intelligence_assistantconversationlog_changelist"))
        html = response.content.decode()
        sidebar_html = html.split('<div id="main"', maxsplit=1)[0]
        self.assertNotIn("Usage Dashboard", sidebar_html)
        self.assertNotIn("Conversation Logs", sidebar_html)

    def test_cli_admin_pages_render_as_admin_tabs(self):
        for url, active_href in (
            (reverse("admin:cli_admin_cliaccesstoken_changelist"), "/admin/cli_admin/cliaccesstoken/"),
            (
                reverse("admin:cli_admin_cliauthorizationcode_changelist"),
                "/admin/cli_admin/cliauthorizationcode/",
            ),
            (reverse("admin:cli_admin_cliauditlog_changelist"), "/admin/cli_admin/cliauditlog/"),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)

                self.assertEqual(response.status_code, 200)
                self.assertContains(response, 'id="tabs-items"')
                self.assertContains(response, 'href="/admin/cli_admin/cliaccesstoken/"')
                self.assertContains(response, 'href="/admin/cli_admin/cliauthorizationcode/"')
                self.assertContains(response, 'href="/admin/cli_admin/cliauditlog/"')
                self.assertContains(response, f'href="{active_href}" class="active"')

        response = self.client.get(reverse("admin:cli_admin_cliaccesstoken_changelist"))
        html = response.content.decode()
        sidebar_html = html.split('<div id="main"', maxsplit=1)[0]
        self.assertNotIn("Authorization Codes", sidebar_html)
        self.assertNotIn("Audit Log", sidebar_html)
