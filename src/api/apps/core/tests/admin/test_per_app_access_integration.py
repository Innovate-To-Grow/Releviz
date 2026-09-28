"""End-to-end per-app admin access via the Django admin test client.

Drives real admin URLs through the full request stack to confirm BaseModelAdmin's
per-app gate: a staff member sees only the apps in their ``admin_apps`` grant, a
superuser (Releviz Master) sees everything, and a grant-less staff member can still load
the (empty) admin index but is forbidden every model.
"""

from django.contrib import admin
from django.test import TestCase
from django.urls import reverse

from apps.core.tests.helpers import make_admin, make_superuser

CORE_URL = "/admin/core/awscredentialconfig/"
AUTHN_URL = "/admin/authn/member/"


class PerAppAdminAccessIntegrationTest(TestCase):
    def test_staff_sees_only_granted_app(self):
        user = make_admin(apps=["core"], email="core-admin@example.com")
        self.client.force_login(user)
        self.assertEqual(self.client.get(CORE_URL).status_code, 200)
        self.assertEqual(self.client.get(AUTHN_URL).status_code, 403)

    def test_staff_granted_scheduling_and_mail_opens_every_page_of_those_apps(self):
        # These admins subclass Unfold's ModelAdmin directly; the grant must reach
        # them too, not only BaseModelAdmin subclasses.
        user = make_admin(apps=["scheduling", "mail"], email="ops-admin@example.com")
        self.client.force_login(user)
        urls = [
            reverse(f"admin:{model._meta.app_label}_{model._meta.model_name}_changelist")
            for model in admin.site._registry
            if model._meta.app_label in ("scheduling", "mail")
        ]
        self.assertGreater(len(urls), 10)
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.client.get("/admin/scheduling/event/add/").status_code, 200)
        self.assertEqual(self.client.get(AUTHN_URL).status_code, 403)

    def test_staff_without_scheduling_or_mail_is_forbidden_their_pages(self):
        user = make_admin(apps=["core"], email="core-admin@example.com")
        self.client.force_login(user)
        self.assertEqual(self.client.get("/admin/scheduling/event/").status_code, 403)
        self.assertEqual(self.client.get("/admin/mail/emailproviderconfig/").status_code, 403)

    def test_grantless_staff_loads_index_but_is_forbidden_models(self):
        user = make_admin(apps=[], email="empty-admin@example.com")
        self.client.force_login(user)
        # The admin index still loads (active staff), just with no accessible apps.
        self.assertEqual(self.client.get("/admin/").status_code, 200)
        self.assertEqual(self.client.get(CORE_URL).status_code, 403)
        self.assertEqual(self.client.get(AUTHN_URL).status_code, 403)

    def test_forbidden_model_renders_branded_403_with_generic_reason(self):
        # Django's own admin gate raises a bare PermissionDenied, so the page
        # falls back to a generic sentence instead of an empty paragraph.
        user = make_admin(apps=[], email="empty-admin@example.com")
        self.client.force_login(user)
        response = self.client.get(CORE_URL)
        self.assertEqual(response.status_code, 403)
        self.assertTemplateUsed(response, "403.html")
        self.assertContains(response, "Permission denied", status_code=403)
        self.assertContains(
            response, "You do not have permission to perform this action.", status_code=403
        )
        self.assertContains(response, 'href="/admin/"', status_code=403)

    def test_superuser_sees_everything(self):
        user = make_superuser(email="master@example.com")
        self.client.force_login(user)
        self.assertEqual(self.client.get(CORE_URL).status_code, 200)
        self.assertEqual(self.client.get(AUTHN_URL).status_code, 200)
