"""Every admin can use JWT admin pages while outstanding tokens stay read-only."""

from datetime import timedelta

from django.contrib import admin
from django.contrib.auth.models import Permission
from django.core.cache import cache
from django.test import RequestFactory, TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from apps.authn.models import Member


class TokenAdminAccessTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.allowed = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Token",
            last_name="Admin",
            is_staff=True,
            admin_apps=[],
        )
        cls.denied = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Other",
            last_name="Member",
            is_staff=False,
            admin_apps=["token_blacklist"],
        )
        # Neither legacy model permissions nor app grants confer the admin role.
        cls.denied.user_permissions.set(
            Permission.objects.filter(content_type__app_label="token_blacklist")
        )
        cls.superuser = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Super", last_name="User"
        )
        cls.legacy_admin = Member.objects.create_user(
            password="StrongPass123!", is_staff=True, admin_apps=["authn"]
        )
        cls.inactive_admin = Member.objects.create_user(
            password="StrongPass123!", is_staff=True, is_active=False
        )
        now = timezone.now()
        cls.token = OutstandingToken.objects.create(
            user=cls.allowed,
            jti="test-outstanding-token",
            token="original-token-value",
            created_at=now,
            expires_at=now + timedelta(days=1),
        )
        cls.blacklisted = BlacklistedToken.objects.create(token=cls.token)

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.factory = RequestFactory()

    def _url(self, model, action, obj=None):
        return reverse(
            f"admin:token_blacklist_{model._meta.model_name}_{action}",
            args=[obj.pk] if obj is not None else None,
        )

    def _request(self, user, method="get"):
        request = getattr(self.factory, method)("/admin/")
        request.user = user
        return request

    def test_admins_with_empty_or_unrelated_grants_can_view_token_lists_and_details(self):
        for user in (self.allowed, self.legacy_admin):
            self.client.force_login(user)
            for model, obj in (
                (OutstandingToken, self.token),
                (BlacklistedToken, self.blacklisted),
            ):
                with self.subTest(user=user, model=model):
                    self.assertEqual(
                        self.client.get(self._url(model, "changelist")).status_code, 200
                    )
                    self.assertEqual(
                        self.client.get(self._url(model, "change", obj)).status_code, 200
                    )

    def test_ordinary_and_inactive_members_cannot_view_token_lists_or_details(self):
        for user in (self.denied, self.inactive_admin):
            self.client.force_login(user)
            for model, obj in (
                (OutstandingToken, self.token),
                (BlacklistedToken, self.blacklisted),
            ):
                with self.subTest(user=user, model=model):
                    for url in (self._url(model, "changelist"), self._url(model, "change", obj)):
                        response = self.client.get(url)
                        self.assertEqual(response.status_code, 302)
                        self.assertIn("/admin/login/", response["Location"])

    def test_app_index_permissions_follow_admin_role(self):
        for user, allowed in (
            (self.allowed, True),
            (self.legacy_admin, True),
            (self.superuser, True),
            (self.denied, False),
            (self.inactive_admin, False),
        ):
            for model in (OutstandingToken, BlacklistedToken):
                with self.subTest(user=user, model=model):
                    model_admin = admin.site._registry[model]
                    request = self._request(user)
                    self.assertEqual(model_admin.has_module_permission(request), allowed)
                    self.assertEqual(model_admin.has_view_permission(request), allowed)

    def test_outstanding_tokens_remain_read_only_for_all_admins(self):
        model_admin = admin.site._registry[OutstandingToken]
        for user in (self.allowed, self.superuser):
            with self.subTest(user=user):
                self.client.force_login(user)
                self.assertEqual(
                    self.client.get(self._url(OutstandingToken, "add")).status_code, 403
                )
                self.assertEqual(
                    self.client.post(self._url(OutstandingToken, "add"), {}).status_code, 403
                )
                self.assertEqual(
                    self.client.post(
                        self._url(OutstandingToken, "change", self.token),
                        {"token": "tampered", "jti": "tampered", "_save": "Save"},
                    ).status_code,
                    403,
                )
                self.assertEqual(
                    self.client.post(
                        self._url(OutstandingToken, "delete", self.token), {"post": "yes"}
                    ).status_code,
                    403,
                )
                request = self._request(user)
                self.assertEqual(model_admin.get_actions(request), {})
                self.assertEqual(
                    set(model_admin.get_readonly_fields(request, self.token)),
                    {field.name for field in OutstandingToken._meta.fields},
                )
                self.token.refresh_from_db()
                self.assertEqual(self.token.token, "original-token-value")
                self.assertEqual(self.token.jti, "test-outstanding-token")
                self.assertEqual(OutstandingToken.objects.count(), 1)

    def test_outstanding_token_change_permission_preserves_safe_method_restriction(self):
        model_admin = admin.site._registry[OutstandingToken]
        for user in (self.allowed, self.denied, self.superuser, self.inactive_admin):
            for method in ("get", "head", "post", "put", "patch", "delete"):
                with self.subTest(user=user, method=method):
                    expected = user.is_active and user.is_staff and method in ("get", "head")
                    self.assertEqual(
                        model_admin.has_change_permission(self._request(user, method), self.token),
                        expected,
                    )

    def test_blacklist_add_change_and_delete_permissions_require_admin_role(self):
        model_admin = admin.site._registry[BlacklistedToken]
        for user, allowed in (
            (self.allowed, True),
            (self.legacy_admin, True),
            (self.superuser, True),
            (self.denied, False),
            (self.inactive_admin, False),
        ):
            with self.subTest(user=user):
                request = self._request(user, "post")
                self.assertEqual(model_admin.has_add_permission(request), allowed)
                self.assertEqual(
                    model_admin.has_change_permission(request, self.blacklisted), allowed
                )
                self.assertEqual(
                    model_admin.has_delete_permission(request, self.blacklisted), allowed
                )
                self.assertEqual("delete_selected" in model_admin.get_actions(request), allowed)

    def test_admin_without_grants_can_blacklist_and_remove_token(self):
        self.client.force_login(self.allowed)
        self.blacklisted.delete()
        response = self.client.post(
            self._url(BlacklistedToken, "add"), {"token": self.token.pk, "_save": "Save"}
        )
        self.assertEqual(response.status_code, 302)
        blacklisted = BlacklistedToken.objects.get(token=self.token)
        response = self.client.post(
            self._url(BlacklistedToken, "change", blacklisted),
            {"token": self.token.pk, "_save": "Save"},
        )
        self.assertEqual(response.status_code, 302)
        response = self.client.post(
            self._url(BlacklistedToken, "delete", blacklisted), {"post": "yes"}
        )
        self.assertEqual(response.status_code, 302)
        self.assertFalse(BlacklistedToken.objects.exists())
        self.assertTrue(OutstandingToken.objects.filter(pk=self.token.pk).exists())

    def test_ordinary_member_cannot_modify_blacklist(self):
        self.client.force_login(self.denied)
        for action, obj, data in (
            ("add", None, {"token": self.token.pk, "_save": "Save"}),
            ("change", self.blacklisted, {"token": self.token.pk, "_save": "Save"}),
            ("delete", self.blacklisted, {"post": "yes"}),
            (
                "changelist",
                None,
                {
                    "action": "delete_selected",
                    "_selected_action": [self.blacklisted.pk],
                    "post": "yes",
                },
            ),
        ):
            with self.subTest(action=action):
                response = self.client.post(self._url(BlacklistedToken, action, obj), data)
                self.assertEqual(response.status_code, 302)
                self.assertIn("/admin/login/", response["Location"])
        self.assertTrue(BlacklistedToken.objects.filter(pk=self.blacklisted.pk).exists())
