"""All active admins can access every app, irrespective of legacy grants."""

from types import SimpleNamespace

from django.test import TestCase

from apps.core.utils.access import user_can_access_app


def _user(**kwargs):
    defaults = {
        "is_authenticated": True,
        "is_active": True,
        "is_staff": True,
        "is_superuser": False,
        "admin_apps": [],
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


class UserCanAccessAppTest(TestCase):
    def test_none_user_denied(self):
        self.assertFalse(user_can_access_app(None, "cms"))

    def test_anonymous_denied(self):
        self.assertFalse(user_can_access_app(_user(is_authenticated=False), "cms"))

    def test_inactive_denied(self):
        self.assertFalse(user_can_access_app(_user(is_active=False, admin_apps=["cms"]), "cms"))

    def test_non_staff_denied(self):
        self.assertFalse(user_can_access_app(_user(is_staff=False, admin_apps=["cms"]), "cms"))

    def test_legacy_superuser_allowed_without_grant(self):
        self.assertTrue(user_can_access_app(_user(is_superuser=True, admin_apps=[]), "cms"))

    def test_staff_with_matching_grant_allowed(self):
        self.assertTrue(user_can_access_app(_user(admin_apps=["cms", "event"]), "event"))

    def test_staff_without_matching_grant_allowed(self):
        self.assertTrue(user_can_access_app(_user(admin_apps=["cms"]), "event"))

    def test_staff_without_any_grants_allowed(self):
        self.assertTrue(user_can_access_app(_user(), "event"))

    def test_missing_admin_apps_attr_allowed(self):
        user = _user()
        del user.admin_apps
        self.assertTrue(user_can_access_app(user, "cms"))

    def test_none_admin_apps_allowed(self):
        self.assertTrue(user_can_access_app(_user(admin_apps=None), "cms"))

    def test_legacy_superuser_flag_does_not_bypass_inactive_or_nonstaff(self):
        for fields in ({"is_active": False}, {"is_staff": False}):
            with self.subTest(fields=fields):
                self.assertFalse(user_can_access_app(_user(is_superuser=True, **fields), "cms"))
