"""Tests for the per-app admin access primitives on ``Member``.

Covers ``Member.admin_apps`` (the JSONField grant list) and
``Member.can_access_app()`` (the thin wrapper around
``apps.core.utils.access.user_can_access_app``).
"""

from django.contrib.auth import get_user_model
from django.test import TestCase

Member = get_user_model()


def _member(first="A", last="B", **kw):
    return Member.objects.create_user(
        password="StrongPass123!", first_name=first, last_name=last, **kw
    )


class MemberAdminAppsFieldTests(TestCase):
    def test_admin_apps_defaults_to_empty_list(self):
        member = _member()
        self.assertEqual(member.admin_apps, [])

    def test_admin_apps_default_persists_to_db(self):
        member = _member()
        member.refresh_from_db()
        self.assertEqual(member.admin_apps, [])

    def test_admin_apps_stores_provided_labels(self):
        member = _member(is_staff=True, admin_apps=["cms", "event"])
        member.refresh_from_db()
        self.assertEqual(member.admin_apps, ["cms", "event"])


class MemberCanAccessAppTests(TestCase):
    def test_granted_app_returns_true_for_staff(self):
        member = _member(is_staff=True, admin_apps=["cms"])
        self.assertTrue(member.can_access_app("cms"))

    def test_ungranted_app_returns_false_for_staff(self):
        member = _member(is_staff=True, admin_apps=["cms"])
        self.assertFalse(member.can_access_app("event"))

    def test_empty_grant_returns_false_for_staff(self):
        member = _member(is_staff=True)
        self.assertFalse(member.can_access_app("cms"))

    def test_superuser_can_access_any_app_regardless_of_grant(self):
        superuser = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Super", last_name="User"
        )
        # Superuser has no admin_apps grant, yet may access every app.
        self.assertEqual(superuser.admin_apps, [])
        self.assertTrue(superuser.can_access_app("cms"))
        self.assertTrue(superuser.can_access_app("event"))
        self.assertTrue(superuser.can_access_app("anything"))

    def test_non_staff_member_with_grant_is_denied(self):
        # A non-staff member must never gain admin access, even if admin_apps is set
        # (e.g. left over after is_staff was revoked).
        member = _member(is_staff=False, admin_apps=["cms"])
        self.assertFalse(member.can_access_app("cms"))

    def test_inactive_staff_member_is_denied(self):
        member = _member(is_staff=True, is_active=False, admin_apps=["cms"])
        self.assertFalse(member.can_access_app("cms"))
