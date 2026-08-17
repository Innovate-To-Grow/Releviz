"""
Tests for Contact Email inlines on the Member admin
change page: visibility for staff users and correct handling of UUID
primary keys during form submission.
"""

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings

from apps.authn.admin.members.forms import MemberCreationForm
from apps.authn.models import ContactEmail

Member = get_user_model()


@override_settings(ROOT_URLCONF="config.urls")
class MemberAdminInlineVisibilityTest(TestCase):
    """Inline sections must render for any staff member granted the ``authn`` app
    (not only superusers), and must be hidden from staff without that grant."""

    # noinspection PyPep8Naming
    def setUp(self):
        cache.clear()
        self.superuser = Member.objects.create_superuser(
            password="super123",
            first_name="Super",
            last_name="User",
            is_staff=True,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.superuser,
            email_address="super@example.com",
            email_type="primary",
            verified=True,
        )

        self.staff_user = Member.objects.create_user(
            password="staff123",
            is_staff=True,
            is_active=True,
            admin_apps=["authn"],
        )
        ContactEmail.objects.create(
            member=self.staff_user,
            email_address="staff@example.com",
            email_type="primary",
            verified=True,
        )

        self.target_member = Member.objects.create_user(
            password="target123",
            first_name="Target",
            last_name="User",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.target_member,
            email_address="target@example.com",
            email_type="primary",
            verified=True,
        )

    # noinspection PyPep8Naming,PyMethodMayBeStatic
    def tearDown(self):
        cache.clear()

    def _change_url(self):
        return f"/admin/authn/member/{self.target_member.pk}/change/"

    def _assert_inlines_visible(self, response):
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "contact_emails-group")
        self.assertContains(response, "Contact Emails")

    def test_superuser_sees_inlines(self):
        self.client.force_login(self.superuser)
        resp = self.client.get(self._change_url())
        self._assert_inlines_visible(resp)

    def test_staff_user_with_authn_access_sees_inlines(self):
        """A non-superuser staff member granted the ``authn`` app sees the inlines —
        per-app access, not per-model Django permissions (apps.core.utils.access)."""
        self.client.force_login(self.staff_user)
        resp = self.client.get(self._change_url())
        self._assert_inlines_visible(resp)

    def test_staff_user_without_authn_access_is_forbidden(self):
        """A staff member without the ``authn`` grant cannot open the Member change page."""
        other_app_staff = Member.objects.create_user(
            password="staff123",
            is_staff=True,
            is_active=True,
            admin_apps=["cms"],
        )
        ContactEmail.objects.create(
            member=other_app_staff,
            email_address="cmsonly@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_login(other_app_staff)
        resp = self.client.get(self._change_url())
        self.assertEqual(resp.status_code, 403)


@override_settings(ROOT_URLCONF="config.urls", ADMIN_REQUIRE_CONFIRMATION=False)
class MemberAdminInlineUUIDSubmitTest(TestCase):
    """Submitting inline forms with UUID PKs must not break on 'None' values.

    Django inline formsets send the literal string "None" for empty UUID
    hidden fields (id, member FK) when adding a new row.  Without the
    NoneSafeUUIDField fix the form returns a validation error:
        "None" is not a valid UUID.
    """

    # noinspection PyPep8Naming
    def setUp(self):
        cache.clear()
        self.admin = Member.objects.create_superuser(
            password="admin123",
            first_name="Admin",
            last_name="User",
            is_staff=True,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.admin,
            email_address="admin@example.com",
            email_type="primary",
            verified=True,
        )
        self.target = Member.objects.create_user(
            password="target123",
            first_name="Target",
            last_name="User",
            is_active=True,
        )

    # noinspection PyPep8Naming,PyMethodMayBeStatic
    def tearDown(self):
        cache.clear()

    def _change_url(self):
        return f"/admin/authn/member/{self.target.pk}/change/"

    def _build_post_data(self, extra_inline_data=None):
        """Load the admin change page, scrape every <input> value, merge
        inline overrides, and return a dict ready for ``self.client.post``.
        """
        resp = self.client.get(self._change_url())
        self.assertEqual(resp.status_code, 200)

        from html.parser import HTMLParser

        fields: dict[str, str] = {}
        textarea_name: str | None = None
        select_name: str | None = None
        selected_value: str | None = None

        class _FormParser(HTMLParser):
            def handle_starttag(self, tag, attrs):
                nonlocal textarea_name, select_name, selected_value
                attr = dict(attrs)
                name = attr.get("name")
                if tag == "input" and name:
                    if attr.get("type") == "checkbox":
                        if "checked" in attr:
                            fields[name] = attr.get("value", "on")
                    else:
                        fields.setdefault(name, attr.get("value", ""))
                elif tag == "textarea" and name:
                    textarea_name = name
                elif tag == "select" and name:
                    select_name = name
                elif tag == "option" and select_name and "selected" in attr:
                    selected_value = attr.get("value", "")

            def handle_data(self, data):
                nonlocal textarea_name
                if textarea_name:
                    fields.setdefault(textarea_name, data.strip())

            def handle_endtag(self, tag):
                nonlocal textarea_name, select_name, selected_value
                if tag == "textarea":
                    textarea_name = None
                elif tag == "select" and select_name:
                    if selected_value is not None:
                        fields.setdefault(select_name, selected_value)
                    select_name = None
                    selected_value = None

        parser = _FormParser()
        parser.feed(resp.content.decode())

        if extra_inline_data:
            fields.update(extra_inline_data)

        fields.pop("_addanother", None)
        fields.pop("_continue", None)
        fields["_save"] = "Save"
        return fields

    def test_add_contact_email_with_none_id_does_not_crash(self):
        """Adding a new inline row sends id='None' — must not produce UUID error."""
        self.client.force_login(self.admin)
        data = self._build_post_data(
            {
                "contact_emails-TOTAL_FORMS": "1",
                "contact_emails-INITIAL_FORMS": "0",
                "contact_emails-0-id": "None",
                "contact_emails-0-member": "None",
                "contact_emails-0-email_address": "new@example.com",
                "contact_emails-0-email_type": "primary",
                "contact_emails-0-verified": "",
                "contact_emails-0-subscribe": "on",
            }
        )
        resp = self.client.post(self._change_url(), data)
        content = resp.content.decode() if resp.status_code == 200 else ""
        self.assertNotIn("is not a valid UUID", content)

    def test_edit_existing_primary_status_with_valid_uuid_works(self):
        """Operational status fields remain editable on a primary email."""
        email = ContactEmail.objects.create(
            member=self.target,
            email_address="existing@example.com",
            email_type="primary",
            verified=False,
        )
        self.client.force_login(self.admin)
        data = self._build_post_data(
            {
                "contact_emails-TOTAL_FORMS": "1",
                "contact_emails-INITIAL_FORMS": "1",
                "contact_emails-0-id": str(email.pk),
                "contact_emails-0-member": str(self.target.pk),
                "contact_emails-0-email_address": "existing@example.com",
                "contact_emails-0-email_type": "primary",
                "contact_emails-0-verified": "on",
                "contact_emails-0-subscribe": "on",
            }
        )
        resp = self.client.post(self._change_url(), data)
        content = resp.content.decode() if resp.status_code == 200 else ""
        self.assertNotIn("is not a valid UUID", content)
        email.refresh_from_db()
        self.assertEqual(email.email_type, "primary")
        self.assertTrue(email.verified)

    def test_inline_rejects_primary_demotion(self):
        email = ContactEmail.objects.create(
            member=self.target,
            email_address="existing@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_login(self.admin)
        data = self._build_post_data(
            {
                "contact_emails-TOTAL_FORMS": "1",
                "contact_emails-INITIAL_FORMS": "1",
                "contact_emails-0-id": str(email.pk),
                "contact_emails-0-member": str(self.target.pk),
                "contact_emails-0-email_address": "existing@example.com",
                "contact_emails-0-email_type": "secondary",
                "contact_emails-0-verified": "on",
                "contact_emails-0-subscribe": "on",
            }
        )

        resp = self.client.post(self._change_url(), data)

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "cannot be edited directly")
        email.refresh_from_db()
        self.assertEqual(email.email_type, "primary")

    def test_inline_rejects_primary_address_edit(self):
        email = ContactEmail.objects.create(
            member=self.target,
            email_address="existing@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_login(self.admin)
        data = self._build_post_data(
            {
                "contact_emails-TOTAL_FORMS": "1",
                "contact_emails-INITIAL_FORMS": "1",
                "contact_emails-0-id": str(email.pk),
                "contact_emails-0-member": str(self.target.pk),
                "contact_emails-0-email_address": "rewritten@example.com",
                "contact_emails-0-email_type": "primary",
                "contact_emails-0-verified": "on",
                "contact_emails-0-subscribe": "on",
            }
        )

        resp = self.client.post(self._change_url(), data)

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "cannot be edited directly")
        email.refresh_from_db()
        self.assertEqual(email.email_address, "existing@example.com")

    def test_inline_rejects_primary_deletion(self):
        email = ContactEmail.objects.create(
            member=self.target,
            email_address="existing@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_login(self.admin)
        data = self._build_post_data(
            {
                "contact_emails-TOTAL_FORMS": "1",
                "contact_emails-INITIAL_FORMS": "1",
                "contact_emails-0-id": str(email.pk),
                "contact_emails-0-member": str(self.target.pk),
                "contact_emails-0-email_address": "existing@example.com",
                "contact_emails-0-email_type": "primary",
                "contact_emails-0-verified": "on",
                "contact_emails-0-subscribe": "on",
                "contact_emails-0-DELETE": "on",
            }
        )

        resp = self.client.post(self._change_url(), data)

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "cannot be deleted directly")
        self.assertTrue(ContactEmail.objects.filter(pk=email.pk).exists())

    def test_inline_rejects_direct_primary_promotion(self):
        primary = ContactEmail.objects.create(
            member=self.target,
            email_address="primary@example.com",
            email_type="primary",
            verified=True,
        )
        secondary = ContactEmail.objects.create(
            member=self.target,
            email_address="secondary@example.com",
            email_type="secondary",
            verified=True,
        )
        self.client.force_login(self.admin)
        data = self._build_post_data()
        total_forms = int(data["contact_emails-TOTAL_FORMS"])
        secondary_index = next(
            index
            for index in range(total_forms)
            if data[f"contact_emails-{index}-id"] == str(secondary.pk)
        )
        data[f"contact_emails-{secondary_index}-email_type"] = "primary"

        resp = self.client.post(self._change_url(), data)

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "cannot be assigned directly")
        primary.refresh_from_db()
        secondary.refresh_from_db()
        self.assertEqual(primary.email_type, "primary")
        self.assertEqual(secondary.email_type, "secondary")

    def test_empty_string_id_does_not_crash(self):
        """Some browsers may send an empty string instead of 'None'."""
        self.client.force_login(self.admin)
        data = self._build_post_data(
            {
                "contact_emails-TOTAL_FORMS": "1",
                "contact_emails-INITIAL_FORMS": "0",
                "contact_emails-0-id": "",
                "contact_emails-0-member": "",
                "contact_emails-0-email_address": "empty-id@example.com",
                "contact_emails-0-email_type": "primary",
                "contact_emails-0-verified": "",
                "contact_emails-0-subscribe": "on",
            }
        )
        resp = self.client.post(self._change_url(), data)
        content = resp.content.decode() if resp.status_code == 200 else ""
        self.assertNotIn("is not a valid UUID", content)

    def test_add_member_with_contact_email_none_id_creates_member(self):
        """Adding a member with a new email inline must tolerate id='None'."""
        self.client.force_login(self.admin)
        email = "admin-add-inline@example.com"
        data = {
            "password1": "",
            "password2": "",
            "first_name": "Monique",
            "middle_name": "",
            "last_name": "Hampton",
            "is_active": "on",
            "contact_emails-TOTAL_FORMS": "1",
            "contact_emails-INITIAL_FORMS": "0",
            "contact_emails-MIN_NUM_FORMS": "0",
            "contact_emails-MAX_NUM_FORMS": "1000",
            "contact_emails-0-id": "None",
            "contact_emails-0-member": "None",
            "contact_emails-0-email_address": email,
            "contact_emails-0-email_type": "primary",
            "contact_emails-0-verified": "on",
            "contact_emails-0-subscribe": "on",
            "_save": "Save",
        }

        resp = self.client.post("/admin/authn/member/add/", data)
        content = resp.content.decode() if resp.status_code == 200 else ""

        self.assertNotIn("is not a valid UUID", content)
        self.assertEqual(resp.status_code, 302)
        contact = ContactEmail.objects.get(email_address=email)
        self.assertEqual(contact.email_type, "primary")
        self.assertTrue(contact.verified)
        self.assertEqual(contact.member.first_name, "Monique")
        self.assertEqual(contact.member.last_name, "Hampton")

    def test_save_new_member_with_none_string_id_generates_uuid(self):
        """Admin save must tolerate third-party widgets assigning id='None'."""
        member_admin = admin.site._registry[Member]
        member = Member(first_name="None", last_name="Id", is_active=True)
        member.id = "None"

        member_admin.save_model(request=None, obj=member, form=None, change=False)

        saved = Member.objects.get(pk=member.pk)
        self.assertEqual(saved.first_name, "None")
        self.assertNotEqual(str(saved.pk), "None")

    def test_save_form_assigns_uuid_before_inline_formsets(self):
        """Admin add must assign a UUID before Django validates inline rows."""
        member_admin = admin.site._registry[Member]
        form = MemberCreationForm(data={"password1": "", "password2": ""})
        self.assertTrue(form.is_valid(), form.errors)

        member = member_admin.save_form(request=None, form=form, change=False)

        self.assertIsNotNone(member.pk)
        self.assertNotEqual(str(member.pk), "None")

    def test_change_member_rejects_contact_email_owned_by_other_member(self):
        """Admin inline must not move another member's email onto this member."""
        other = Member.objects.create_user(
            password="other123",
            first_name="Other",
            last_name="User",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=other,
            email_address="claimed@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_login(self.admin)
        data = self._build_post_data(
            {
                "contact_emails-TOTAL_FORMS": "1",
                "contact_emails-INITIAL_FORMS": "0",
                "contact_emails-0-id": "None",
                "contact_emails-0-member": "None",
                "contact_emails-0-email_address": "CLAIMED@example.com",
                "contact_emails-0-email_type": "primary",
                "contact_emails-0-verified": "on",
                "contact_emails-0-subscribe": "on",
            }
        )

        resp = self.client.post(self._change_url(), data)

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "This email address is already assigned to another member.")
        self.assertFalse(
            ContactEmail.objects.filter(
                member=self.target, email_address__iexact="claimed@example.com"
            ).exists()
        )

    def test_add_member_rejects_contact_email_owned_by_other_member(self):
        """Admin add page must reject a new member with another member's email."""
        other = Member.objects.create_user(
            password="other123",
            first_name="Other",
            last_name="User",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=other,
            email_address="claimed-add@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_login(self.admin)
        data = {
            "password1": "",
            "password2": "",
            "first_name": "Monique",
            "middle_name": "",
            "last_name": "Hampton",
            "is_active": "on",
            "contact_emails-TOTAL_FORMS": "1",
            "contact_emails-INITIAL_FORMS": "0",
            "contact_emails-MIN_NUM_FORMS": "0",
            "contact_emails-MAX_NUM_FORMS": "1000",
            "contact_emails-0-id": "None",
            "contact_emails-0-member": "None",
            "contact_emails-0-email_address": "CLAIMED-ADD@example.com",
            "contact_emails-0-email_type": "primary",
            "contact_emails-0-verified": "on",
            "contact_emails-0-subscribe": "on",
            "_save": "Save",
        }

        resp = self.client.post("/admin/authn/member/add/", data)

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "This email address is already assigned to another member.")
        self.assertFalse(Member.objects.filter(first_name="Monique", last_name="Hampton").exists())
        self.assertEqual(
            ContactEmail.objects.filter(email_address__iexact="claimed-add@example.com").count(), 1
        )
