from django.conf import settings
from django.contrib import admin
from django.test import RequestFactory, SimpleTestCase
from unfold.sites import UnfoldAdminSite

from apps.authn.models import Member
from apps.core.models import AWSCredentialConfig


class UnfoldAdminSiteConfigurationTests(SimpleTestCase):
    def test_default_admin_site_exposes_unfold_search_route(self):
        self.assertIsInstance(admin.site, UnfoldAdminSite)
        route_names = {getattr(pattern, "name", None) for pattern in admin.site.get_urls()}
        self.assertIn("search", route_names)

    def test_shared_aws_credentials_are_registered_and_linked(self):
        self.assertIn(AWSCredentialConfig, admin.site._registry)
        configured_links = {
            item["link"]
            for collection in (
                settings.UNFOLD["SIDEBAR"]["navigation"],
                settings.UNFOLD["TABS"],
            )
            for section in collection
            for item in section["items"]
        }
        self.assertIn("/admin/core/awscredentialconfig/", configured_links)

    def test_sidebar_does_not_link_to_unregistered_groups_admin(self):
        sidebar_links = {
            item["link"]
            for section in settings.UNFOLD["SIDEBAR"]["navigation"]
            for item in section["items"]
        }
        tab_links = {item["link"] for tab in settings.UNFOLD["TABS"] for item in tab["items"]}

        self.assertNotIn("/admin/auth/group/", sidebar_links | tab_links)

    def test_each_tab_group_has_at_most_one_sidebar_entry(self):
        sidebar_links = {
            item["link"]
            for section in settings.UNFOLD["SIDEBAR"]["navigation"]
            for item in section["items"]
        }

        for tab in settings.UNFOLD["TABS"]:
            exposed_links = sidebar_links & {item["link"] for item in tab["items"]}
            with self.subTest(models=tab.get("models")):
                self.assertLessEqual(len(exposed_links), 1)

    def test_active_administrators_see_all_sidebar_items_without_app_grants(self):
        request = RequestFactory().get("/admin/")
        request.user = Member(is_active=True, is_staff=True, is_superuser=False, admin_apps=[])
        items = [
            item for section in admin.site.get_sidebar_list(request) for item in section["items"]
        ]
        self.assertTrue(items)
        self.assertTrue(all(item["has_permission"] for item in items))

    def test_regular_and_inactive_accounts_see_no_sidebar_items(self):
        for is_active, is_staff in ((True, False), (False, True)):
            request = RequestFactory().get("/admin/")
            request.user = Member(is_active=is_active, is_staff=is_staff)
            items = [
                item
                for section in admin.site.get_sidebar_list(request)
                for item in section["items"]
            ]
            with self.subTest(is_active=is_active, is_staff=is_staff):
                self.assertFalse(any(item["has_permission"] for item in items))
