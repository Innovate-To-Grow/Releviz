"""Administrator authorization and protected impersonation targets."""

from io import BytesIO
from unittest.mock import patch

from django.contrib import admin
from django.core.cache import cache
from django.core.exceptions import PermissionDenied
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse
from openpyxl import Workbook

from apps.authn.models import ContactEmail, ImpersonationToken, Member


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


@override_settings(ROOT_URLCONF="config.urls", ADMIN_REQUIRE_CONFIRMATION=False)
class AdministratorAccountManagementTests(TestCase):
    """Administrators manage one another's accounts; Django's compatibility flag
    is never consulted."""

    def setUp(self):
        cache.clear()
        self.administrator = _administrator(first_name="Admin", last_name="User")
        self.other_administrator = _administrator(first_name="Other", last_name="Admin")
        self.regular = Member.objects.create_user(
            password="StrongPass123!", first_name="Reg", last_name="Ular", is_active=True
        )
        self.client.force_login(self.administrator)

    def tearDown(self):
        cache.clear()

    @staticmethod
    def _password_url(member):
        return reverse("admin:auth_user_password_change", args=[member.pk])

    @staticmethod
    def _password_data():
        return {
            "set_usable_password": "true",
            "password1": "Takeover-Pass-42!",
            "password2": "Takeover-Pass-42!",
        }

    def _run_action(self, action, members):
        return self.client.post(
            reverse("admin:authn_member_changelist"),
            {
                "action": action,
                "index": "0",
                "_selected_action": [str(member.pk) for member in members],
            },
            follow=True,
        )

    def _add_email(self, member):
        return self.client.post(
            reverse("admin:authn_contactemail_add"),
            {
                "member": str(member.pk),
                "email_address": f"{member.first_name.lower()}-alias@example.com",
                "email_type": "secondary",
            },
        )

    def test_administrator_sets_another_administrators_password(self):
        response = self.client.post(
            self._password_url(self.other_administrator), self._password_data()
        )
        self.assertEqual(response.status_code, 302)
        self.other_administrator.refresh_from_db()
        self.assertTrue(self.other_administrator.check_password("Takeover-Pass-42!"))

    def test_administrator_activation_actions_reach_other_administrators(self):
        targets = (self.other_administrator, self.regular)
        response = self._run_action("deactivate_members", targets)
        self.assertContains(response, "2 member(s) deactivated.")
        self.assertNotContains(response, "skipped")
        for member in targets:
            member.refresh_from_db()
            self.assertFalse(member.is_active)

        response = self._run_action("activate_members", targets)
        self.assertContains(response, "2 member(s) activated.")
        for member in targets:
            member.refresh_from_db()
            self.assertTrue(member.is_active)

    def test_regular_member_page_stays_editable_with_the_password_summary(self):
        url = reverse("admin:authn_member_change", args=[self.regular.pk])
        content = self.client.get(url).content.decode()
        self.assertIn('name="first_name"', content)
        self.assertNotIn(self.regular.password, content)

    def test_administrator_adds_an_email_for_another_administrator(self):
        self.assertEqual(self._add_email(self.other_administrator).status_code, 302)
        self.assertTrue(self.other_administrator.contact_emails.exists())

    def test_active_staff_manages_administrators_without_legacy_superuser_flag(self):
        # Member.save mirrors the flag from the role, so only a row written around
        # it carries is_staff alone; signing in leaves it that way (update_last_login
        # saves last_login only). The member admin consults the role, never the flag.
        Member.objects.filter(pk=self.administrator.pk).update(is_superuser=False)
        self.client.force_login(self.administrator)
        third = _administrator(first_name="Third", last_name="Admin")

        response = self.client.post(
            self._password_url(self.other_administrator), self._password_data()
        )
        self.assertEqual(response.status_code, 302)
        self.other_administrator.refresh_from_db()
        self.assertTrue(self.other_administrator.check_password("Takeover-Pass-42!"))

        self.assertEqual(self._add_email(self.other_administrator).status_code, 302)
        self.assertTrue(self.other_administrator.contact_emails.exists())

        response = self._run_action("deactivate_members", (self.other_administrator, third))
        self.assertContains(response, "2 member(s) deactivated.")
        self.assertNotContains(response, "skipped")

        response = self.client.post(
            reverse("admin:authn_member_delete", args=[self.other_administrator.pk]),
            {"post": "yes"},
        )
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Member.objects.filter(pk=self.other_administrator.pk).exists())

        self.assertFalse(Member.objects.get(pk=self.administrator.pk).is_superuser)


@override_settings(ROOT_URLCONF="config.urls")
class MemberImportAdministratorRoleTests(TestCase):
    """The import's Staff column grants the Administrator role like the change form."""

    def setUp(self):
        cache.clear()
        self.administrator = _administrator(first_name="Ivo", last_name="Importer")
        self.target = Member.objects.create_user(
            password="StrongPass123!", first_name="Tomas", last_name="Target", is_active=True
        )
        ContactEmail.objects.create(
            member=self.target, email_address="target@example.com", email_type="primary"
        )

    def tearDown(self):
        cache.clear()

    def _import(self, rows):
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(["First Name", "Last Name", "Primary Email", "Active", "Staff"])
        for row in rows:
            sheet.append(row)
        payload = BytesIO()
        workbook.save(payload)
        upload = SimpleUploadedFile("members.xlsx", payload.getvalue())
        return self.client.post(
            reverse("admin:authn_member_import_excel"),
            {"excel_file": upload, "update_existing": "on"},
        )

    def test_administrator_import_grants_the_administrator_role(self):
        self.client.force_login(self.administrator)
        response = self._import([["Tomas", "Target", "target@example.com", "TRUE", "TRUE"]])
        self.assertEqual(response.context["result"].updated_count, 1)
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_staff)
        self.assertTrue(self.target.is_superuser)
