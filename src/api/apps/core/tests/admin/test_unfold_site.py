from django.conf import settings
from django.contrib import admin
from django.test import SimpleTestCase
from unfold.sites import UnfoldAdminSite

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
