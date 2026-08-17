"""Security regression tests for MemberAdmin authorization.

Covers two confirmed privilege-escalation findings:

* The custom ``impersonate`` admin URL was wrapped only in ``admin_site.admin_view``
  (is_staff only) — any staff member could mint a login token for a superuser.
* ``is_staff`` and ``admin_apps`` were freely editable on the Member change form,
  so a non-superuser admin could grant themselves every app / staff status.
"""

from django.contrib import admin
from django.core.cache import cache
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse

from apps.authn.models import ContactEmail, ImpersonationToken, Member


def _staff(admin_apps=None, **kwargs):
    member = Member.objects.create_user(
        password="StrongPass123!", is_staff=True, is_active=True, **kwargs
    )
    if admin_apps is not None:
        member.admin_apps = admin_apps
        member.save(update_fields=["admin_apps"])
    return member


class ImpersonateAuthorizationTests(TestCase):
    """The impersonate URL must enforce authn-app access and refuse to mint a
    token for a privileged (staff/superuser) account."""

    def setUp(self):
        cache.clear()
        self.superuser = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Super", last_name="User", is_active=True
        )
        self.regular_target = Member.objects.create_user(
            password="StrongPass123!", first_name="Reg", last_name="Ular", is_active=True
        )

    def tearDown(self):
        cache.clear()

    def _url(self, target):
        return reverse("admin:authn_member_impersonate", args=[target.pk])

    def test_non_authn_staff_cannot_impersonate_superuser(self):
        attacker = _staff(admin_apps=["event"], first_name="Low", last_name="Priv")
        self.client.force_login(attacker)
        # Django converts the view's PermissionDenied into a 403 response.
        self.assertEqual(self.client.get(self._url(self.superuser)).status_code, 403)
        self.assertFalse(ImpersonationToken.objects.filter(member=self.superuser).exists())

    def test_authn_admin_cannot_impersonate_superuser(self):
        authn_admin = _staff(admin_apps=["authn"], first_name="Authn", last_name="Admin")
        self.client.force_login(authn_admin)
        self.assertEqual(self.client.get(self._url(self.superuser)).status_code, 403)
        self.assertFalse(ImpersonationToken.objects.filter(member=self.superuser).exists())

    def test_authn_admin_cannot_impersonate_other_staff(self):
        authn_admin = _staff(admin_apps=["authn"], first_name="Authn", last_name="Admin")
        other_staff = _staff(admin_apps=["mail"], first_name="Other", last_name="Staff")
        self.client.force_login(authn_admin)
        self.assertEqual(self.client.get(self._url(other_staff)).status_code, 403)
        self.assertFalse(ImpersonationToken.objects.filter(member=other_staff).exists())

    def test_authn_admin_can_impersonate_regular_member(self):
        authn_admin = _staff(admin_apps=["authn"], first_name="Authn", last_name="Admin")
        self.client.force_login(authn_admin)
        response = self.client.get(self._url(self.regular_target))
        self.assertEqual(response.status_code, 302)
        self.assertIn("/impersonate-login#token=", response["Location"])
        self.assertTrue(ImpersonationToken.objects.filter(member=self.regular_target).exists())

    def test_superuser_can_impersonate_regular_member(self):
        self.client.force_login(self.superuser)
        response = self.client.get(self._url(self.regular_target))
        self.assertEqual(response.status_code, 302)
        self.assertTrue(ImpersonationToken.objects.filter(member=self.regular_target).exists())

    def test_superuser_cannot_impersonate_another_superuser(self):
        # Even I2G Master may not impersonate another privileged account.
        other_super = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Other", last_name="Master", is_active=True
        )
        self.client.force_login(self.superuser)
        self.assertEqual(self.client.get(self._url(other_super)).status_code, 403)
        self.assertFalse(ImpersonationToken.objects.filter(member=other_super).exists())


class MemberToolingAuthorizationTests(TestCase):
    """The member import/export/template custom URLs expose or create PII member
    records, so they must require authn-app access — not merely is_staff."""

    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_non_authn_staff_cannot_export_members(self):
        attacker = _staff(admin_apps=["event"], first_name="Low", last_name="Priv")
        self.client.force_login(attacker)
        resp = self.client.get(reverse("admin:authn_member_export_excel"))
        self.assertEqual(resp.status_code, 403)

    def test_non_authn_staff_cannot_open_import(self):
        attacker = _staff(admin_apps=["event"], first_name="Low", last_name="Priv")
        self.client.force_login(attacker)
        self.assertEqual(
            self.client.get(reverse("admin:authn_member_import_excel")).status_code, 403
        )

    def test_non_authn_staff_cannot_download_template(self):
        attacker = _staff(admin_apps=["event"], first_name="Low", last_name="Priv")
        self.client.force_login(attacker)
        self.assertEqual(
            self.client.get(reverse("admin:authn_member_import_template")).status_code, 403
        )

    def test_authn_admin_can_export_members(self):
        authn_admin = _staff(admin_apps=["authn"], first_name="Authn", last_name="Admin")
        self.client.force_login(authn_admin)
        resp = self.client.get(reverse("admin:authn_member_export_excel"))
        self.assertEqual(resp.status_code, 200)


class PrivilegeFieldEditTests(TestCase):
    """``is_staff`` and ``admin_apps`` may be edited only by superusers; for
    everyone else they are read-only and excluded from the bound form, so a
    submitted value cannot escalate privileges."""

    def setUp(self):
        self.model_admin = admin.site._registry[Member]
        # A concrete instance so UserAdmin returns the *change* form (obj=None
        # would yield the add form, which omits these fields regardless).
        self.target = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Edit",
            last_name="Target",
            is_staff=True,
            is_active=True,
        )

    def _request(self, user):
        request = RequestFactory().get("/")
        request.user = user
        return request

    def test_privilege_fields_readonly_for_non_superuser(self):
        request = self._request(Member(is_superuser=False, is_staff=True, is_active=True))
        readonly = self.model_admin.get_readonly_fields(request, self.target)
        self.assertIn("is_staff", readonly)
        self.assertIn("admin_apps", readonly)

    def test_privilege_fields_editable_for_superuser(self):
        request = self._request(Member(is_superuser=True, is_staff=True, is_active=True))
        readonly = self.model_admin.get_readonly_fields(request, self.target)
        self.assertNotIn("is_staff", readonly)
        self.assertNotIn("admin_apps", readonly)

    def test_non_superuser_form_cannot_bind_privilege_fields(self):
        # If the fields are absent from the bound form, a POST can never set them.
        request = self._request(Member(is_superuser=False, is_staff=True, is_active=True))
        form_class = self.model_admin.get_form(request, obj=self.target, change=True)
        self.assertNotIn("is_staff", form_class.base_fields)
        self.assertNotIn("admin_apps", form_class.base_fields)

    def test_superuser_form_can_bind_privilege_fields(self):
        request = self._request(Member(is_superuser=True, is_staff=True, is_active=True))
        form_class = self.model_admin.get_form(request, obj=self.target, change=True)
        self.assertIn("is_staff", form_class.base_fields)
        self.assertIn("admin_apps", form_class.base_fields)


@override_settings(ROOT_URLCONF="config.urls", ADMIN_REQUIRE_CONFIRMATION=False)
class PrivilegeFieldPostTests(TestCase):
    """End-to-end: a non-superoperator cannot widen their own privileges by
    POSTing is_staff / admin_apps to their own change page."""

    def setUp(self):
        cache.clear()
        self.attacker = _staff(admin_apps=["authn"], first_name="Self", last_name="Escalate")
        ContactEmail.objects.create(
            member=self.attacker,
            email_address="attacker@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_login(self.attacker)

    def tearDown(self):
        cache.clear()

    def test_post_cannot_grant_extra_apps_or_staff(self):
        url = f"/admin/authn/member/{self.attacker.pk}/change/"
        # Scrape the rendered form, then inject escalation values the read-only
        # form never offered.
        get_resp = self.client.get(url)
        self.assertEqual(get_resp.status_code, 200)
        # The privilege fields must not render as editable inputs.
        content = get_resp.content.decode()
        self.assertNotIn('name="admin_apps"', content)

        data = {
            "first_name": "Self",
            "last_name": "Escalate",
            "is_active": "on",
            "is_staff": "on",
            "admin_apps": ["cms", "mail", "event", "authn"],
            "contact_emails-TOTAL_FORMS": "0",
            "contact_emails-INITIAL_FORMS": "0",
            "contact_emails-MIN_NUM_FORMS": "0",
            "contact_emails-MAX_NUM_FORMS": "1000",
            "_save": "Save",
        }
        self.client.post(url, data)
        self.attacker.refresh_from_db()
        # The injected escalation values were ignored: app grant unchanged.
        self.assertEqual(self.attacker.admin_apps, ["authn"])
