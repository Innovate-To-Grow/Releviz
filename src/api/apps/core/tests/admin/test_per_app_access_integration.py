"""End-to-end per-app admin access via the Django admin test client.

Drives real admin URLs through the full request stack to confirm BaseModelAdmin's
per-app gate: a staff member sees only the apps in their ``admin_apps`` grant, a
superuser (I2G Master) sees everything, and a grant-less staff member can still load
the (empty) admin index but is forbidden every model.
"""

from django.test import TestCase

from apps.event.tests.helpers import make_admin, make_superuser

CMS_URL = "/admin/cms/cmspage/"
EVENT_URL = "/admin/event/event/"
PROJECTS_URL = "/admin/projects/project/"


class PerAppAdminAccessIntegrationTest(TestCase):
    def test_staff_sees_only_granted_app(self):
        user = make_admin(apps=["cms"], email="cms-admin@example.com")
        self.client.force_login(user)
        self.assertEqual(self.client.get(CMS_URL).status_code, 200)
        self.assertEqual(self.client.get(EVENT_URL).status_code, 403)
        self.assertEqual(self.client.get(PROJECTS_URL).status_code, 403)

    def test_grantless_staff_loads_index_but_is_forbidden_models(self):
        user = make_admin(apps=[], email="empty-admin@example.com")
        self.client.force_login(user)
        # The admin index still loads (active staff), just with no accessible apps.
        self.assertEqual(self.client.get("/admin/").status_code, 200)
        self.assertEqual(self.client.get(CMS_URL).status_code, 403)
        self.assertEqual(self.client.get(EVENT_URL).status_code, 403)

    def test_superuser_sees_everything(self):
        user = make_superuser(email="master@example.com")
        self.client.force_login(user)
        self.assertEqual(self.client.get(CMS_URL).status_code, 200)
        self.assertEqual(self.client.get(EVENT_URL).status_code, 200)
        self.assertEqual(self.client.get(PROJECTS_URL).status_code, 200)
