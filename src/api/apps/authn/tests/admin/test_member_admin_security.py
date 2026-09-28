"""Security regression tests for MemberAdmin authorization.

Covers two confirmed privilege-escalation findings:

* The custom ``impersonate`` admin URL was wrapped only in ``admin_site.admin_view``
  (is_staff only) — any staff member could mint a login token for a superuser.
* ``is_staff`` and ``admin_apps`` were freely editable on the Member change form,
  so a non-superuser admin could grant themselves every app / staff status.
"""

from io import BytesIO

from django.contrib import admin
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse
from openpyxl import Workbook

from apps.authn.admin.members.helpers import readonly_profile_image
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
        # Even Releviz Master may not impersonate another privileged account.
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


@override_settings(ROOT_URLCONF="config.urls", ADMIN_REQUIRE_CONFIRMATION=False)
class PrivilegedAccountChangeTests(TestCase):
    """A non-superuser member admin must not take over a staff or superuser
    account by setting its password or giving it an email that signs in to the
    admin — the same escalation impersonation refuses."""

    def setUp(self):
        cache.clear()
        self.authn_admin = _staff(admin_apps=["authn"], first_name="Authn", last_name="Admin")
        self.superuser = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Super", last_name="User", is_active=True
        )
        self.other_staff = _staff(admin_apps=["core"], first_name="Other", last_name="Staff")
        self.regular = Member.objects.create_user(
            password="StrongPass123!", first_name="Reg", last_name="Ular", is_active=True
        )
        self.client.force_login(self.authn_admin)

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

    def test_authn_admin_cannot_set_a_privileged_password(self):
        for target in (self.superuser, self.other_staff):
            with self.subTest(target=target.first_name):
                url = self._password_url(target)
                self.assertEqual(self.client.get(url).status_code, 403)
                self.assertEqual(self.client.post(url, self._password_data()).status_code, 403)
                target.refresh_from_db()
                self.assertTrue(target.check_password("StrongPass123!"))

    def test_authn_admin_sets_a_regular_members_password_and_their_own(self):
        for target in (self.regular, self.authn_admin):
            with self.subTest(target=target.first_name):
                url = self._password_url(target)
                self.assertEqual(self.client.get(url).status_code, 200)
                response = self.client.post(url, self._password_data())
                self.assertEqual(response.status_code, 302)
                target.refresh_from_db()
                self.assertTrue(target.check_password("Takeover-Pass-42!"))

    def test_superuser_sets_a_staff_members_password(self):
        self.client.force_login(self.superuser)
        response = self.client.post(self._password_url(self.other_staff), self._password_data())
        self.assertEqual(response.status_code, 302)
        self.other_staff.refresh_from_db()
        self.assertTrue(self.other_staff.check_password("Takeover-Pass-42!"))

    def test_privileged_member_page_is_read_only_without_the_password_hash(self):
        url = reverse("admin:authn_member_change", args=[self.superuser.pk])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        content = response.content.decode()
        self.assertNotIn('name="first_name"', content)
        self.assertNotIn(self.superuser.password, content)
        self.assertNotIn(self._password_url(self.superuser), content)

        # Neither a field change nor an added sign-in email is saved.
        data = {
            "first_name": "Taken",
            "last_name": "Over",
            "contact_emails-TOTAL_FORMS": "1",
            "contact_emails-INITIAL_FORMS": "0",
            "contact_emails-MIN_NUM_FORMS": "0",
            "contact_emails-MAX_NUM_FORMS": "1000",
            "contact_emails-0-email_address": "attacker@example.com",
            "contact_emails-0-email_type": "secondary",
            "contact_emails-0-verified": "on",
            "_save": "Save",
        }
        self.assertEqual(self.client.post(url, data).status_code, 403)
        self.superuser.refresh_from_db()
        self.assertEqual(self.superuser.first_name, "Super")
        self.assertFalse(ContactEmail.objects.filter(email_address="attacker@example.com").exists())

    def test_authn_admin_cannot_delete_a_privileged_account(self):
        for target in (self.superuser, self.other_staff):
            with self.subTest(target=target.first_name):
                url = reverse("admin:authn_member_delete", args=[target.pk])
                self.assertEqual(self.client.get(url).status_code, 403)
                self.assertEqual(self.client.post(url, {"post": "yes"}).status_code, 403)
                self.assertTrue(Member.objects.filter(pk=target.pk).exists())

        url = reverse("admin:authn_member_delete", args=[self.regular.pk])
        self.assertEqual(self.client.get(url).status_code, 200)
        self.client.force_login(self.superuser)
        url = reverse("admin:authn_member_delete", args=[self.other_staff.pk])
        self.assertEqual(self.client.get(url).status_code, 200)

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

    def test_activation_actions_skip_privileged_accounts(self):
        targets = (self.superuser, self.other_staff, self.regular)
        response = self._run_action("deactivate_members", targets)
        self.assertContains(response, "1 member(s) deactivated.")
        self.assertContains(
            response, "2 staff or superuser account(s) skipped: only a superuser can change them."
        )
        for member, active in (
            (self.superuser, True),
            (self.other_staff, True),
            (self.regular, False),
        ):
            member.refresh_from_db()
            self.assertEqual(member.is_active, active)

        Member.objects.filter(pk=self.other_staff.pk).update(is_active=False)
        response = self._run_action("activate_members", (self.other_staff, self.regular))
        self.assertContains(response, "1 member(s) activated.")
        self.assertContains(response, "1 staff or superuser account(s) skipped")
        self.other_staff.refresh_from_db()
        self.assertFalse(self.other_staff.is_active)

    def test_superuser_activation_actions_reach_staff(self):
        self.client.force_login(self.superuser)
        response = self._run_action("deactivate_members", (self.other_staff, self.authn_admin))
        self.assertContains(response, "2 member(s) deactivated.")
        self.assertNotContains(response, "skipped")
        self.other_staff.refresh_from_db()
        self.assertFalse(self.other_staff.is_active)

    def test_privileged_member_page_shows_the_profile_image_not_its_data(self):
        image = "data:image/png;base64," + "iVBORw0KGgo" * 20
        Member.objects.filter(pk=self.superuser.pk).update(profile_image=image)
        url = reverse("admin:authn_member_change", args=[self.superuser.pk])
        content = self.client.get(url).content.decode()
        self.assertIn(f'<img src="{image}" alt="Profile image"', content)
        self.assertNotIn(f">{image}", content)

    def test_readonly_profile_image_keeps_other_values(self):
        self.assertEqual(readonly_profile_image("-"), "-")

    def test_regular_member_page_stays_editable_with_the_password_summary(self):
        url = reverse("admin:authn_member_change", args=[self.regular.pk])
        content = self.client.get(url).content.decode()
        self.assertIn('name="first_name"', content)
        self.assertNotIn(self.regular.password, content)

    def test_authn_admin_cannot_give_a_privileged_account_a_sign_in_email(self):
        add_url = reverse("admin:authn_contactemail_add")
        for target in (self.superuser, self.other_staff):
            with self.subTest(target=target.first_name):
                response = self.client.post(
                    add_url,
                    {
                        "member": str(target.pk),
                        "email_address": f"attacker-{target.first_name.lower()}@example.com",
                        "email_type": "secondary",
                        "verified": "on",
                    },
                )
                self.assertEqual(response.status_code, 200)
                self.assertIn("member", response.context["adminform"].form.errors)
                self.assertFalse(target.contact_emails.exists())

        # Nor retarget an existing privileged email to an address they control.
        email = ContactEmail.objects.create(
            member=self.superuser,
            email_address="master-alias@example.com",
            email_type="secondary",
            verified=True,
        )
        change_url = reverse("admin:authn_contactemail_change", args=[email.pk])
        self.assertNotIn('name="email_address"', self.client.get(change_url).content.decode())
        response = self.client.post(
            change_url,
            {
                "member": str(self.superuser.pk),
                "email_address": "attacker@example.com",
                "email_type": "secondary",
                "verified": "on",
            },
        )
        self.assertEqual(response.status_code, 403)
        email.refresh_from_db()
        self.assertEqual(email.email_address, "master-alias@example.com")

    def _privileged_and_regular_emails(self):
        return (
            ContactEmail.objects.create(
                member=self.superuser,
                email_address="master-alias@example.com",
                email_type="secondary",
            ),
            ContactEmail.objects.create(
                member=self.regular, email_address="reg-alias@example.com", email_type="secondary"
            ),
        )

    def test_email_bulk_actions_skip_privileged_accounts(self):
        master, regular = self._privileged_and_regular_emails()
        changelist = reverse("admin:authn_contactemail_changelist")
        for action, message in (
            ("mark_verified", "1 email(s) marked as verified."),
            ("toggle_subscribe", "Toggled subscription for 1 email(s)."),
        ):
            with self.subTest(action=action):
                response = self.client.post(
                    changelist,
                    {"action": action, "index": "0", "_selected_action": [master.pk, regular.pk]},
                    follow=True,
                )
                self.assertContains(response, message)
        master.refresh_from_db()
        regular.refresh_from_db()
        self.assertEqual((master.verified, master.subscribe), (False, True))
        self.assertEqual((regular.verified, regular.subscribe), (True, False))

        ContactEmail.objects.filter(pk=master.pk).update(verified=True)
        response = self.client.post(
            changelist,
            {"action": "make_primary", "index": "0", "_selected_action": [master.pk]},
            follow=True,
        )
        self.assertContains(
            response, "Only a superuser can change a staff or superuser account&#x27;s emails."
        )
        master.refresh_from_db()
        self.assertEqual(master.email_type, "secondary")

        delete_url = reverse("admin:authn_contactemail_delete", args=[master.pk])
        self.assertEqual(self.client.get(delete_url).status_code, 403)
        delete_url = reverse("admin:authn_contactemail_delete", args=[regular.pk])
        self.assertEqual(self.client.get(delete_url).status_code, 200)

    def test_email_list_edits_skip_privileged_accounts(self):
        master, regular = self._privileged_and_regular_emails()
        changelist = reverse("admin:authn_contactemail_changelist")

        def edit(email):
            return self.client.post(
                changelist,
                {
                    "form-TOTAL_FORMS": "1",
                    "form-INITIAL_FORMS": "1",
                    "form-MIN_NUM_FORMS": "0",
                    "form-MAX_NUM_FORMS": "1000",
                    "form-0-id": str(email.pk),
                    "form-0-verified": "on",
                    "form-0-subscribe": "on",
                    "_save": "Save",
                },
            )

        # Django leaves a row the admin may not change out of the save.
        self.assertEqual(edit(master).status_code, 302)
        master.refresh_from_db()
        self.assertFalse(master.verified)
        self.assertEqual(edit(regular).status_code, 302)
        regular.refresh_from_db()
        self.assertTrue(regular.verified)

    def test_authn_admin_adds_emails_for_regular_members_and_themselves(self):
        add_url = reverse("admin:authn_contactemail_add")
        for target in (self.regular, self.authn_admin):
            with self.subTest(target=target.first_name):
                response = self.client.post(
                    add_url,
                    {
                        "member": str(target.pk),
                        "email_address": f"{target.first_name.lower()}-alias@example.com",
                        "email_type": "secondary",
                    },
                )
                self.assertEqual(response.status_code, 302)
                self.assertTrue(target.contact_emails.exists())

    def test_superuser_adds_an_email_for_a_staff_member(self):
        self.client.force_login(self.superuser)
        response = self.client.post(
            reverse("admin:authn_contactemail_add"),
            {
                "member": str(self.other_staff.pk),
                "email_address": "staff-alias@example.com",
                "email_type": "secondary",
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(self.other_staff.contact_emails.exists())


@override_settings(ROOT_URLCONF="config.urls")
class MemberImportPrivilegeTests(TestCase):
    """The member import must not change staff status or privileged accounts for a
    non-superuser admin, any more than the change form does."""

    def setUp(self):
        cache.clear()
        self.authn_admin = _staff(admin_apps=["authn"], first_name="Ivo", last_name="Importer")
        self.target = Member.objects.create_user(
            password="StrongPass123!", first_name="Tomas", last_name="Target", is_active=True
        )
        ContactEmail.objects.create(
            member=self.target, email_address="target@example.com", email_type="primary"
        )
        self.superuser = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Super", last_name="User", is_active=True
        )
        ContactEmail.objects.create(
            member=self.superuser, email_address="master@example.com", email_type="primary"
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

    def test_non_superuser_import_ignores_staff_and_skips_privileged_rows(self):
        self.client.force_login(self.authn_admin)
        response = self._import(
            [
                ["Tomasz", "Target", "target@example.com", "TRUE", "TRUE"],
                ["Super", "User", "master@example.com", "FALSE", "FALSE"],
            ]
        )
        self.assertEqual(response.status_code, 200)
        result = response.context["result"]
        self.assertEqual(result.updated_count, 1)
        self.assertEqual(result.errors, ["Row 3: You do not have permission to update this member"])

        self.target.refresh_from_db()
        self.assertEqual(self.target.first_name, "Tomasz")
        self.assertFalse(self.target.is_staff)
        self.superuser.refresh_from_db()
        self.assertTrue(self.superuser.is_active)
        self.assertTrue(self.superuser.is_staff)

    def test_superuser_import_sets_staff(self):
        self.client.force_login(self.superuser)
        response = self._import([["Tomas", "Target", "target@example.com", "TRUE", "TRUE"]])
        self.assertEqual(response.context["result"].updated_count, 1)
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_staff)
