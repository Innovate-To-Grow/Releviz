"""Administrator authorization and protected impersonation targets."""

from unittest.mock import patch

from django.contrib import admin
from django.core.cache import cache
from django.core.exceptions import PermissionDenied
from django.test import RequestFactory, TestCase
from django.urls import reverse

from apps.authn.models import ImpersonationToken, Member


def _administrator(**kwargs):
    return Member.objects.create_user(
        password="StrongPass123!", is_staff=True, is_active=True, **kwargs
    )


class ImpersonateAuthorizationTests(TestCase):
    def setUp(self):
        cache.clear()
        self.administrator = _administrator(first_name="Admin", last_name="User")
        self.regular_target = Member.objects.create_user(
            password="StrongPass123!", first_name="Regular", last_name="Member"
        )

    def tearDown(self):
        cache.clear()

    def _url(self, target):
        return reverse("admin:authn_member_impersonate", args=[target.pk])

    def test_administrator_without_app_grants_can_impersonate_regular_member(self):
        self.client.force_login(self.administrator)
        response = self.client.get(self._url(self.regular_target))
        self.assertEqual(response.status_code, 302)
        self.assertIn("/impersonate-login#token=", response["Location"])
        self.assertTrue(ImpersonationToken.objects.filter(member=self.regular_target).exists())

    def test_administrator_cannot_impersonate_another_administrator(self):
        other = _administrator(first_name="Other", last_name="Admin")
        self.client.force_login(self.administrator)
        response = self.client.get(self._url(other))
        self.assertEqual(response.status_code, 403)
        self.assertContains(
            response, "Administrator accounts cannot be impersonated.", status_code=403
        )
        self.assertFalse(ImpersonationToken.objects.filter(member=other).exists())

    def test_legacy_superuser_target_is_also_protected(self):
        # Protect inconsistent historical data before any normalizing save occurs.
        Member.objects.filter(pk=self.regular_target.pk).update(is_superuser=True, is_staff=False)
        self.client.force_login(self.administrator)
        self.assertEqual(self.client.get(self._url(self.regular_target)).status_code, 403)
        self.assertFalse(ImpersonationToken.objects.filter(member=self.regular_target).exists())

    def test_regular_member_cannot_impersonate_anyone(self):
        self.client.force_login(self.regular_target)
        for target in (self.regular_target, self.administrator):
            with self.subTest(target=target.pk):
                self.assertEqual(self.client.get(self._url(target)).status_code, 302)
        self.assertFalse(ImpersonationToken.objects.exists())

    def test_inactive_administrator_cannot_impersonate_members(self):
        self.administrator.is_active = False
        self.administrator.save(update_fields=["is_active"])
        self.client.force_login(self.administrator)
        self.assertEqual(self.client.get(self._url(self.regular_target)).status_code, 302)
        self.assertFalse(ImpersonationToken.objects.exists())

    def test_impersonate_button_is_hidden_for_administrator_targets(self):
        self.client.force_login(self.administrator)
        response = self.client.get(
            reverse("admin:authn_member_change", args=[self.administrator.pk])
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, self._url(self.administrator))


class MemberToolingAuthorizationTests(TestCase):
    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def _tool_urls(self):
        return [
            reverse("admin:authn_member_export_excel"),
            reverse("admin:authn_member_import_excel"),
            reverse("admin:authn_member_import_template"),
        ]

    def test_every_administrator_can_use_member_tools(self):
        for legacy_grants in ([], ["scheduling"]):
            administrator = _administrator(admin_apps=legacy_grants)
            self.client.force_login(administrator)
            for url in self._tool_urls():
                with self.subTest(legacy_grants=legacy_grants, url=url):
                    self.assertEqual(self.client.get(url).status_code, 200)

    def test_regular_member_cannot_use_member_tools(self):
        member = Member.objects.create_user(first_name="Regular", last_name="Member")
        self.client.force_login(member)
        for url in self._tool_urls():
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 302)


class AdministratorFieldEditTests(TestCase):
    def setUp(self):
        self.model_admin = admin.site._registry[Member]
        self.target = Member.objects.create_user(first_name="Edit", last_name="Target")

    def test_active_staff_can_edit_administrator_role_without_legacy_superuser_flag(self):
        request = RequestFactory().get("/")
        request.user = Member(is_staff=True, is_superuser=False, is_active=True)
        self.assertNotIn("is_staff", self.model_admin.get_readonly_fields(request, self.target))
        form = self.model_admin.get_form(request, obj=self.target, change=True)
        self.assertIn("is_staff", form.base_fields)
        self.assertNotIn("is_superuser", form.base_fields)
        self.assertNotIn("admin_apps", form.base_fields)


class MemberHandlerAuthorizationTests(TestCase):
    """Custom handlers enforce access even without the public admin wrapper."""

    def setUp(self):
        self.model_admin = admin.site._registry[Member]
        self.target = Member.objects.create_user(first_name="Target", last_name="Member")

    def _assert_denied(self, handler, reason, *args):
        for is_active, is_staff in ((True, False), (False, True)):
            request = RequestFactory().post("/admin/authn/member/")
            request.user = Member(is_active=is_active, is_staff=is_staff)
            with self.subTest(is_active=is_active, is_staff=is_staff):
                with self.assertNumQueries(0), self.assertRaisesMessage(PermissionDenied, reason):
                    handler(request, *args)

    def test_import_handler_denies_before_importing_members(self):
        with patch("apps.authn.services.members.import_.import_members_from_excel") as importer:
            self._assert_denied(
                self.model_admin.import_excel_view,
                "You do not have permission to import members.",
            )
            importer.assert_not_called()
        self.assertEqual(Member.objects.count(), 1)

    def test_template_handler_denies_before_generating_download(self):
        with patch("apps.authn.services.members.import_.generate_template_excel") as generate:
            self._assert_denied(
                self.model_admin.download_template_view,
                "You do not have permission to access member tooling.",
            )
            generate.assert_not_called()

    def test_export_handler_denies_before_reading_or_exporting_member_data(self):
        with patch("apps.authn.admin.members.helpers.export_members_response") as exporter:
            self._assert_denied(
                self.model_admin.export_excel_view,
                "You do not have permission to export members.",
            )
            exporter.assert_not_called()

    def test_impersonate_handler_denies_before_generating_tokens(self):
        with patch.object(ImpersonationToken, "generate_token") as generate:
            self._assert_denied(
                self.model_admin.impersonate_view,
                "You do not have permission to impersonate members.",
                str(self.target.pk),
            )
            generate.assert_not_called()
        self.assertFalse(ImpersonationToken.objects.exists())
