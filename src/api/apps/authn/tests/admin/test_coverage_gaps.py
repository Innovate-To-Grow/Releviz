"""Coverage gaps for admin forms, inlines, helpers, Unfold context, and login edge cases."""

from __future__ import annotations

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings

from apps.authn.models import ContactEmail

Member = get_user_model()


# ---------------------------------------------------------------------------
# admin/members/forms.py
# ---------------------------------------------------------------------------
class Base64ImageWidgetTests(SimpleTestCase):
    def _widget(self):
        from apps.authn.admin.members.forms import Base64ImageWidget

        return Base64ImageWidget()

    def test_value_from_datadict_clear_checkbox_returns_empty(self):
        """forms.py:37 — clear checkbox checked, no upload -> returns empty string."""
        widget = self._widget()
        name = "profile_image"
        clear_name = widget.clear_checkbox_name(name)
        result = widget.value_from_datadict({clear_name: "on"}, {}, name)
        self.assertEqual(result, "")

    def test_render_shows_preview_for_existing_base64(self):
        """forms.py:53-63 — long base64 value renders an <img> preview."""
        widget = self._widget()
        value = "data:image/png;base64," + ("A" * 60)
        html = widget.render("profile_image", value)
        self.assertIn("<img", html)
        self.assertIn(value, html)
        self.assertIn("Current image", html)

    def test_render_prepends_data_uri_for_bare_base64(self):
        """forms.py:53 — value without data: prefix gets a data:image/png prefix."""
        widget = self._widget()
        value = "B" * 60  # >50 chars, no "data:" prefix
        html = widget.render("profile_image", value)
        self.assertIn(f"data:image/png;base64,{value}", html)


class MemberCreationFormPasswordIncompleteTests(TestCase):
    def test_only_one_password_field_set_is_invalid(self):
        """forms.py:101-108 — one field filled, the other blank -> password_incomplete error."""
        from django.forms.utils import ErrorDict

        from apps.authn.admin.members.forms import MemberCreationForm

        form = MemberCreationForm(
            {
                "first_name": "Half",
                "last_name": "Password",
                "password1": "OnlyOnePass123!",
                "password2": "",
                "is_active": "on",
            }
        )
        form.cleaned_data = {"password1": "OnlyOnePass123!", "password2": ""}
        form._errors = ErrorDict()
        form.validate_passwords()
        self.assertIn("password2", form._errors)
        self.assertEqual(form._errors["password2"].data[0].code, "password_incomplete")
        self.assertNotIn("set_usable_password", form.cleaned_data)


class MemberChangeFormClearImageTests(TestCase):
    def test_clear_checkbox_clears_image(self):
        """forms.py:129 — clear checkbox in submitted data clears the stored image."""
        from apps.authn.admin.members.forms import MemberChangeForm

        member = Member.objects.create_user(
            first_name="Avatar",
            last_name="User",
            password="StrongPass123!",
            profile_image="data:image/png;base64,old-image",
        )
        clear_name = MemberChangeForm().fields["profile_image"].widget.clear_checkbox_name("profile_image")
        data = {
            "password": member.password,
            "first_name": member.first_name,
            "middle_name": "",
            "last_name": member.last_name,
            "organization": "",
            "title": "",
            "profile_image": "",
            clear_name: "on",
            "is_active": "on",
            "is_staff": "",
            "is_superuser": "",
            "groups": [],
            "user_permissions": [],
            "last_login": "",
            "date_joined": member.date_joined.isoformat(),
        }
        form = MemberChangeForm(data=data, files={}, instance=member)
        self.assertTrue(form.is_valid(), form.errors)
        saved = form.save()
        self.assertEqual(saved.profile_image, "")


class MemberImportFormValidationTests(SimpleTestCase):
    def test_wrong_extension_rejected(self):
        """forms.py:180 — non-xlsx/xls extension raises a validation error."""
        from apps.authn.admin.members.forms import MemberImportForm

        upload = SimpleUploadedFile("members.txt", b"data", content_type="text/plain")
        form = MemberImportForm(data={}, files={"excel_file": upload})
        self.assertFalse(form.is_valid())
        self.assertIn("excel_file", form.errors)
        self.assertIn(".xlsx or .xls", str(form.errors["excel_file"]))

    def test_oversized_file_rejected(self):
        """forms.py:184 — file larger than 5MB raises a validation error."""
        from apps.authn.admin.members.forms import MemberImportForm

        big = SimpleUploadedFile(
            "members.xlsx",
            b"x" * (5 * 1024 * 1024 + 1),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        form = MemberImportForm(data={}, files={"excel_file": big})
        self.assertFalse(form.is_valid())
        self.assertIn("excel_file", form.errors)
        self.assertIn("cannot exceed 5MB", str(form.errors["excel_file"]))


# ---------------------------------------------------------------------------
# admin/members/inlines.py
# ---------------------------------------------------------------------------
class NoneSafeFieldTests(SimpleTestCase):
    def test_uuid_field_treats_none_string_as_empty(self):
        """inlines.py:13-15 — NoneSafeUUIDField.to_python('None') -> None."""
        from apps.authn.admin.members.inlines import NoneSafeUUIDField

        field = NoneSafeUUIDField()
        self.assertIsNone(field.to_python("None"))
        self.assertIsNone(field.to_python(""))
        self.assertIsNone(field.to_python(None))

    def test_uuid_field_parses_real_uuid(self):
        """inlines.py:15 — a genuine UUID string falls through to super().to_python."""
        import uuid

        from apps.authn.admin.members.inlines import NoneSafeUUIDField

        value = uuid.uuid4()
        field = NoneSafeUUIDField()
        self.assertEqual(field.to_python(str(value)), value)


class NoneSafeInlineForeignKeyFieldTests(TestCase):
    def test_inline_fk_field_treats_none_string_as_empty(self):
        """inlines.py:31-32 — NoneSafeInlineForeignKeyField.clean('None') normalizes to None."""
        from django.core.exceptions import ValidationError

        from apps.authn.admin.members.inlines import NoneSafeInlineForeignKeyField

        parent = Member.objects.create_user(password="x", first_name="P", last_name="Q")
        field = NoneSafeInlineForeignKeyField(parent_instance=parent, to_field="pk")
        self.assertIs(field.clean("None"), parent)
        with self.assertRaises(ValidationError):
            field.clean("not-the-parent-pk")


class UUIDInlineMixinTests(TestCase):
    def test_formfield_for_uuid_dbfield_gets_none_safe_class(self):
        """inlines.py:90 — formfield_for_dbfield reclasses a UUIDField to NoneSafeUUIDField."""
        from django.contrib.admin.sites import AdminSite

        from apps.authn.admin.members.inlines import ContactEmailInline, NoneSafeUUIDField
        from apps.authn.models import ContactEmail as _ContactEmail

        inline = ContactEmailInline(Member, AdminSite())
        request = RequestFactory().get("/")
        request.user = Member.objects.create_user(first_name="A", last_name="B", password="StrongPass123!")
        uuid_dbfield = _ContactEmail._meta.get_field("id")
        formfield = inline.formfield_for_dbfield(uuid_dbfield, request)
        self.assertIsInstance(formfield, NoneSafeUUIDField)

    def test_normalize_replaces_none_string_in_querydict(self):
        """inlines.py:53 — setlist runs when a 'None' value is normalized to ''."""
        from django.http import QueryDict

        from apps.authn.admin.members.inlines import NoneSafeUUIDInlineFormSet

        data = QueryDict(mutable=True)
        data["contact_emails-0-id"] = "None"
        normalized = NoneSafeUUIDInlineFormSet._normalize_none_uuid_values(data, "contact_emails")
        self.assertEqual(normalized.get("contact_emails-0-id"), "")


@override_settings(ROOT_URLCONF="config.routing.urls", ADMIN_REQUIRE_CONFIRMATION=False)
class ContactEmailInlinePrimaryFormsetTests(TestCase):
    """inlines.py:116 — submitting two primary emails through the admin is rejected."""

    def setUp(self):
        from django.core.cache import cache

        cache.clear()
        self.admin = Member.objects.create_superuser(
            password="admin123", first_name="Admin", last_name="User", is_staff=True, is_active=True
        )
        ContactEmail.objects.create(
            member=self.admin, email_address="admin@example.com", email_type="primary", verified=True
        )
        self.target = Member.objects.create_user(
            first_name="Target", last_name="User", password="target123", is_active=True
        )

    def tearDown(self):
        from django.core.cache import cache

        cache.clear()

    def test_more_than_one_primary_raises_validation_error(self):
        self.client.force_login(self.admin)
        data = {
            "password1": "",
            "password2": "",
            "first_name": "Two",
            "middle_name": "",
            "last_name": "Primaries",
            "organization": "",
            "title": "",
            "is_active": "on",
            "contact_emails-TOTAL_FORMS": "2",
            "contact_emails-INITIAL_FORMS": "0",
            "contact_emails-MIN_NUM_FORMS": "0",
            "contact_emails-MAX_NUM_FORMS": "1000",
            "contact_emails-0-id": "None",
            "contact_emails-0-member": "None",
            "contact_emails-0-email_address": "first@example.com",
            "contact_emails-0-email_type": "primary",
            "contact_emails-0-verified": "on",
            "contact_emails-0-subscribe": "on",
            "contact_emails-1-id": "None",
            "contact_emails-1-member": "None",
            "contact_emails-1-email_address": "second@example.com",
            "contact_emails-1-email_type": "primary",
            "contact_emails-1-verified": "on",
            "contact_emails-1-subscribe": "on",
            "contact_phones-TOTAL_FORMS": "0",
            "contact_phones-INITIAL_FORMS": "0",
            "contact_phones-MIN_NUM_FORMS": "0",
            "contact_phones-MAX_NUM_FORMS": "1000",
            "_save": "Save",
        }
        resp = self.client.post("/admin/authn/member/add/", data)
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "A member may only have one primary email.")
        self.assertFalse(Member.objects.filter(first_name="Two", last_name="Primaries").exists())


# ---------------------------------------------------------------------------
# admin/members/helpers.py:103
# ---------------------------------------------------------------------------
class ImportResultMessageTests(TestCase):
    def test_import_view_appends_error_count_to_message(self):
        """helpers.py:103 — success message includes error count when errors present."""
        from apps.authn.admin.members import helpers
        from apps.authn.services.members.import_.types import ImportResult

        captured = {}

        class FakeAdmin:
            def has_view_permission(self, request, obj=None):
                return True

            def message_user(self, request, message, level=None):
                captured["message"] = message
                captured["level"] = level

        result = ImportResult(
            success=True,
            created_count=1,
            updated_count=0,
            skipped_count=0,
            errors=["row 5 bad email"],
        )

        request = RequestFactory().post("/import/", {})

        with (
            patch.object(helpers, "MemberImportForm") as FormCls,
            patch(
                "apps.authn.services.members.import_.import_members_from_excel",
                return_value=result,
            ),
            patch.object(helpers, "build_import_context", return_value={}),
            patch.object(helpers, "render", return_value="rendered"),
        ):
            form = FormCls.return_value
            form.is_valid.return_value = True
            form.cleaned_data = {"excel_file": object(), "set_password": "", "update_existing": False}
            helpers.import_excel_view(FakeAdmin(), request)

        self.assertIn("1 error(s)", captured["message"])
        self.assertEqual(captured["level"], "warning")


# ---------------------------------------------------------------------------
# views/admin/invitation.py:36  (_get_unfold_context no each_context)
# ---------------------------------------------------------------------------
class UnfoldContextTests(SimpleTestCase):
    def test_get_unfold_context_returns_empty_without_each_context(self):
        """invitation.py:36 — site without each_context returns {}."""
        from apps.authn.views.admin import invitation

        request = RequestFactory().get("/")

        class _Site:
            pass

        with patch.object(invitation.admin, "site", _Site()):
            ctx = invitation._get_unfold_context(request)
        self.assertEqual(ctx, {})


# ---------------------------------------------------------------------------
# views/admin/login/password.py:36 and views/admin/login/email_code.py:112-113
# ---------------------------------------------------------------------------
@override_settings(ROOT_URLCONF="config.routing.urls")
class AdminPasswordFormInvalidTests(TestCase):
    def setUp(self):
        from django.core.cache import cache

        cache.clear()

    def tearDown(self):
        from django.core.cache import cache

        cache.clear()

    def test_password_step_invalid_form_rerenders(self):
        """password.py:36 — invalid AdminPasswordForm (no password) re-renders password step."""
        response = self.client.post(
            "/admin/login/",
            {"mode": "password", "email": "someone@example.com"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context["step"], "password")
        self.assertFalse(response.wsgi_request.user.is_authenticated)


@override_settings(ROOT_URLCONF="config.routing.urls")
class AdminEmailCodeStateMissingTests(TestCase):
    def setUp(self):
        from django.core.cache import cache

        cache.clear()

    def tearDown(self):
        from django.core.cache import cache

        cache.clear()

    def test_code_step_without_email_state_falls_back_to_email(self):
        """email_code.py:112-113 — code step with empty email/member_id clears session, shows email form."""
        session = self.client.session
        session["admin_login_step"] = "code"
        session["admin_login_email"] = ""
        session.save()

        response = self.client.post(
            "/admin/login/",
            {"code": "123456"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context["step"], "email")
        self.assertNotIn("admin_login_step", self.client.session)
