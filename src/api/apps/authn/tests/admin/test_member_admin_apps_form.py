"""The member editor exposes one Administrator role with full backend access."""

from django import forms
from django.contrib import admin
from django.core.cache import cache
from django.test import Client, RequestFactory, TestCase, override_settings
from django.urls import reverse

from apps.authn.admin.members.forms import MemberChangeForm
from apps.authn.models import Member

LEGACY_PERMISSION_FIELDS = ("admin_apps", "is_superuser", "groups", "user_permissions")


def _admin_form(obj=None):
    request = RequestFactory().get("/")
    # Verify the editor does not require the legacy superuser flag.
    request.user = Member(is_staff=True, is_superuser=False, is_active=True)
    return admin.site._registry[Member].get_form(request, obj=obj, change=obj is not None)


class MemberAdministratorFormTests(TestCase):
    def setUp(self):
        self.member = Member.objects.create_user(first_name="Form", last_name="Member")

    def test_change_form_exposes_single_administrator_toggle(self):
        form = _admin_form(self.member)()
        field = form.fields["is_staff"]
        self.assertIsInstance(field, forms.BooleanField)
        self.assertEqual(field.label, "Administrator")
        self.assertIn("full access", field.help_text)
        self.assertFalse(field.required)
        for name in LEGACY_PERMISSION_FIELDS:
            self.assertNotIn(name, form.fields)
            self.assertNotIn(name, MemberChangeForm().fields)

    def test_creation_form_exposes_the_same_role(self):
        form = _admin_form()()
        self.assertEqual(form.fields["is_staff"].label, "Administrator")
        self.assertFalse(form.fields["is_staff"].required)
        for name in LEGACY_PERMISSION_FIELDS:
            self.assertNotIn(name, form.fields)


@override_settings(ROOT_URLCONF="config.urls", ADMIN_REQUIRE_CONFIRMATION=False)
class MemberAdministratorPageTests(TestCase):
    def setUp(self):
        cache.clear()
        self.administrator = Member.objects.create_user(
            password="StrongPass123!", first_name="Admin", last_name="User", is_staff=True
        )
        self.target = Member.objects.create_user(
            password="StrongPass123!", first_name="Target", last_name="Member"
        )
        self.client.force_login(self.administrator)

    def tearDown(self):
        cache.clear()

    def _change_url(self):
        return reverse("admin:authn_member_change", args=[self.target.pk])

    def _post_data(self, **overrides):
        return {
            "first_name": "Target",
            "last_name": "Member",
            "is_active": "on",
            "contact_emails-TOTAL_FORMS": "0",
            "contact_emails-INITIAL_FORMS": "0",
            "contact_emails-MIN_NUM_FORMS": "0",
            "contact_emails-MAX_NUM_FORMS": "1000",
            "_save": "Save",
            **overrides,
        }

    def test_add_and_change_pages_have_no_separate_permission_controls(self):
        for url in (self._change_url(), reverse("admin:authn_member_add")):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200)
                self.assertContains(response, 'name="is_staff"')
                self.assertContains(response, "Administrator")
                for name in LEGACY_PERMISSION_FIELDS:
                    self.assertNotContains(response, f'name="{name}"')

    def test_administrator_can_promote_member_to_full_backend_access(self):
        response = self.client.post(self._change_url(), self._post_data(is_staff="on"))
        self.assertEqual(response.status_code, 302, response.content.decode())
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_staff)
        self.assertTrue(self.target.is_superuser)
        self.assertEqual(self.target.admin_apps, [])

        promoted_client = Client()
        promoted_client.force_login(self.target)
        self.assertEqual(promoted_client.get("/admin/scheduling/event/").status_code, 200)
        self.assertEqual(promoted_client.get("/admin/core/awscredentialconfig/").status_code, 200)

    def test_administrator_can_demote_another_administrator(self):
        self.target.is_staff = True
        self.target.save(update_fields=["is_staff"])
        demoted_client = Client()
        demoted_client.force_login(self.target)

        response = self.client.post(self._change_url(), self._post_data())
        self.assertEqual(response.status_code, 302, response.content.decode())
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_staff)
        self.assertFalse(self.target.is_superuser)
        self.assertEqual(demoted_client.get("/admin/authn/member/").status_code, 302)

    def test_administrator_can_create_another_administrator(self):
        response = self.client.post(
            reverse("admin:authn_member_add"),
            self._post_data(first_name="New", is_staff="on", password1="", password2=""),
        )
        self.assertEqual(response.status_code, 302, response.content.decode())
        created = Member.objects.get(first_name="New")
        self.assertTrue(created.is_staff)
        self.assertTrue(created.is_superuser)

    def test_legacy_fields_cannot_override_administrator_toggle(self):
        self.target.admin_apps = ["mail"]
        self.target.save(update_fields=["admin_apps"])
        response = self.client.post(
            self._change_url(),
            self._post_data(is_superuser="on", admin_apps=["scheduling"]),
        )
        self.assertEqual(response.status_code, 302, response.content.decode())
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_staff)
        self.assertFalse(self.target.is_superuser)
        self.assertEqual(self.target.admin_apps, ["mail"])

    def test_regular_member_cannot_promote_self(self):
        self.client.force_login(self.target)
        response = self.client.post(self._change_url(), self._post_data(is_staff="on"))
        self.assertEqual(response.status_code, 302)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_staff)
        self.assertFalse(self.target.is_superuser)
