"""Direct unit tests for authn admin actions and helper methods.

These call admin action methods directly via a RequestFactory request wired
with message storage, sidestepping the confirm-on-save flow.
"""

import uuid
from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.contrib.auth import get_user_model
from django.contrib.messages.storage.fallback import FallbackStorage
from django.core.exceptions import PermissionDenied
from django.test import RequestFactory, TestCase, override_settings

from apps.authn.admin.members.contact.email import ContactEmailAdmin, ContactEmailAdminForm
from apps.authn.admin.members.contact.phone import ContactPhoneAdmin
from apps.authn.admin.members.invitation import AdminInvitationAdmin
from apps.authn.admin.members.member import MemberAdmin
from apps.authn.admin.security import RSAKeypairAdmin
from apps.authn.models import (
    AdminInvitation,
    ContactEmail,
    ContactPhone,
    MemberSheetSyncConfig,
    MemberSheetSyncLog,
    RSAKeypair,
)
from apps.authn.services.members.sheet_sync.admin import (
    MemberSheetSyncConfigAdmin,
    MemberSheetSyncLogAdmin,
)

Member = get_user_model()


def _request(rf, user, method="get", path="/admin/", data=None):
    req = getattr(rf, method)(path, data or {})
    req.user = user
    req.session = {}
    req._messages = FallbackStorage(req)
    return req


class _AdminTestBase(TestCase):
    def setUp(self):
        self.rf = RequestFactory()
        self.site = AdminSite()
        self.admin_user = Member.objects.create_superuser(
            password="admin123", first_name="Admin", last_name="User", is_staff=True, is_active=True
        )
        ContactEmail.objects.create(
            member=self.admin_user, email_address="admin@example.com", email_type="primary", verified=True
        )

    def _messages(self, request):
        return [str(m) for m in request._messages]


class MemberAdminActionTests(_AdminTestBase):
    def setUp(self):
        super().setUp()
        self.model_admin = MemberAdmin(Member, self.site)
        self.m1 = Member.objects.create_user(password="t", first_name="Mem", last_name="One", is_active=False)
        ContactEmail.objects.create(member=self.m1, email_address="m1@example.com", email_type="primary")

    def test_get_primary_email_display(self):
        self.assertEqual(self.model_admin.get_primary_email_display(self.m1), "m1@example.com")

    def test_get_primary_email_display_dash_when_missing(self):
        bare = Member.objects.create_user(password="t", first_name="No", last_name="Email")
        self.assertEqual(self.model_admin.get_primary_email_display(bare), "-")

    def test_get_full_name_display(self):
        self.assertEqual(self.model_admin.get_full_name_display(self.m1), "Mem One")

    def test_activate_members_action(self):
        request = _request(self.rf, self.admin_user)
        self.model_admin.activate_members(request, Member.objects.filter(pk=self.m1.pk))
        self.m1.refresh_from_db()
        self.assertTrue(self.m1.is_active)
        self.assertIn("1 member(s) activated.", self._messages(request))

    def test_deactivate_members_action(self):
        self.m1.is_active = True
        self.m1.save(update_fields=["is_active"])
        request = _request(self.rf, self.admin_user)
        self.model_admin.deactivate_members(request, Member.objects.filter(pk=self.m1.pk))
        self.m1.refresh_from_db()
        self.assertFalse(self.m1.is_active)
        self.assertIn("1 member(s) deactivated.", self._messages(request))

    def test_export_members_to_excel_action(self):
        request = _request(self.rf, self.admin_user)
        response = self.model_admin.export_members_to_excel(request, Member.objects.all())
        self.assertEqual(response.status_code, 200)
        self.assertIn("spreadsheetml.sheet", response["Content-Type"])
        self.assertIn("attachment;", response["Content-Disposition"])

    def test_export_members_to_vcard_action(self):
        request = _request(self.rf, self.admin_user)
        response = self.model_admin.export_members_to_vcard(request, Member.objects.all())
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["Content-Type"].startswith("text/vcard"))

    @patch("apps.authn.services.members.sheet_sync.sync_members_to_sheet", return_value=7)
    def test_sync_all_members_to_sheet_success(self, mock_sync):
        request = _request(self.rf, self.admin_user)
        self.model_admin.sync_all_members_to_sheet(request, Member.objects.all())
        self.assertIn("Synced 7 members to Google Sheet.", self._messages(request))

    @patch(
        "apps.authn.services.members.sheet_sync.sync_members_to_sheet",
        side_effect=RuntimeError("sheets down"),
    )
    def test_sync_all_members_to_sheet_failure(self, mock_sync):
        request = _request(self.rf, self.admin_user)
        self.model_admin.sync_all_members_to_sheet(request, Member.objects.all())
        self.assertTrue(any("Sheet sync failed" in m for m in self._messages(request)))

    def test_ensure_new_member_uuid_assigns_when_blank(self):
        obj = Member(first_name="X", last_name="Y")
        obj.id = "None"
        MemberAdmin._ensure_new_member_uuid(obj, change=False)
        self.assertIsInstance(obj.id, uuid.UUID)

    def test_ensure_new_member_uuid_skips_on_change(self):
        existing = self.m1.id
        MemberAdmin._ensure_new_member_uuid(self.m1, change=True)
        self.assertEqual(self.m1.id, existing)

    @override_settings(FRONTEND_URL="https://frontend.example.com")
    def test_impersonate_view_redirects_with_token(self):
        request = _request(self.rf, self.admin_user, path=f"/admin/authn/member/{self.m1.pk}/impersonate/")
        response = self.model_admin.impersonate_view(request, str(self.m1.pk))
        self.assertEqual(response.status_code, 302)
        self.assertIn("https://frontend.example.com/impersonate-login#token=", response.url)

    def test_export_excel_view(self):
        request = _request(self.rf, self.admin_user)
        response = self.model_admin.export_excel_view(request)
        self.assertEqual(response.status_code, 200)

    def test_download_template_view_success(self):
        request = _request(self.rf, self.admin_user)
        response = self.model_admin.download_template_view(request)
        self.assertEqual(response.status_code, 200)
        self.assertIn("member_import_template.xlsx", response["Content-Disposition"])

    def test_download_template_view_import_error(self):
        request = _request(self.rf, self.admin_user)
        with patch(
            "apps.authn.services.members.import_.generate_template_excel",
            side_effect=ImportError("openpyxl missing"),
        ):
            response = self.model_admin.download_template_view(request)
        self.assertEqual(response.status_code, 302)
        self.assertTrue(any("openpyxl missing" in m for m in self._messages(request)))

    def test_import_excel_view_get_renders_form(self):
        request = _request(self.rf, self.admin_user, path="/admin/authn/member/import-excel/")
        response = self.model_admin.import_excel_view(request)
        self.assertEqual(response.status_code, 200)

    def test_import_excel_view_post_imports_members(self):
        from io import BytesIO

        from django.core.files.uploadedfile import SimpleUploadedFile
        from openpyxl import Workbook

        workbook = Workbook()
        worksheet = workbook.active
        worksheet.append(["Primary Email", "First Name", "Last Name", "Organization"])
        worksheet.append(["imported@example.com", "Imp", "Orted", "Acme"])
        payload = BytesIO()
        workbook.save(payload)
        payload.seek(0)

        upload = SimpleUploadedFile(
            "members.xlsx",
            payload.getvalue(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        request = self.rf.post("/admin/authn/member/import-excel/", {"excel_file": upload})
        request.user = self.admin_user
        request.session = {}
        from django.contrib.messages.storage.fallback import FallbackStorage

        request._messages = FallbackStorage(request)

        response = self.model_admin.import_excel_view(request)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(ContactEmail.objects.filter(email_address="imported@example.com").exists())
        self.assertTrue(any("Import complete" in str(m) for m in request._messages))

    def test_import_excel_view_update_existing_requires_change_permission(self):
        from io import BytesIO

        from django.core.files.uploadedfile import SimpleUploadedFile
        from openpyxl import Workbook

        workbook = Workbook()
        worksheet = workbook.active
        worksheet.append(["Primary Email", "First Name", "Last Name", "Organization"])
        worksheet.append(["imported@example.com", "Imp", "Orted", "Acme"])
        payload = BytesIO()
        workbook.save(payload)
        payload.seek(0)

        upload = SimpleUploadedFile(
            "members.xlsx",
            payload.getvalue(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        request = self.rf.post("/admin/authn/member/import-excel/", {"excel_file": upload, "update_existing": "on"})
        request.user = self.admin_user
        request.session = {}
        request._messages = FallbackStorage(request)

        with patch.object(self.model_admin, "has_change_permission", return_value=False):
            with self.assertRaises(PermissionDenied):
                self.model_admin.import_excel_view(request)


class ContactEmailAdminTests(_AdminTestBase):
    def setUp(self):
        super().setUp()
        self.model_admin = ContactEmailAdmin(ContactEmail, self.site)
        self.member = Member.objects.create_user(password="t", first_name="C", last_name="E")
        self.email = ContactEmail.objects.create(
            member=self.member, email_address="c@example.com", email_type="primary", subscribe=False
        )

    def test_mark_verified(self):
        request = _request(self.rf, self.admin_user)
        self.model_admin.mark_verified(request, ContactEmail.objects.filter(pk=self.email.pk))
        self.email.refresh_from_db()
        self.assertTrue(self.email.verified)
        self.assertIn("1 email(s) marked as verified.", self._messages(request))

    def test_mark_unverified(self):
        self.email.verified = True
        self.email.save(update_fields=["verified"])
        request = _request(self.rf, self.admin_user)
        self.model_admin.mark_unverified(request, ContactEmail.objects.filter(pk=self.email.pk))
        self.email.refresh_from_db()
        self.assertFalse(self.email.verified)
        self.assertIn("1 email(s) marked as unverified.", self._messages(request))

    def test_toggle_subscribe(self):
        request = _request(self.rf, self.admin_user)
        self.model_admin.toggle_subscribe(request, ContactEmail.objects.filter(pk=self.email.pk))
        self.email.refresh_from_db()
        self.assertTrue(self.email.subscribe)
        self.assertTrue(any("Toggled subscription" in m for m in self._messages(request)))

    def test_primary_identity_fields_are_readonly(self):
        readonly = self.model_admin.get_readonly_fields(
            _request(self.rf, self.admin_user),
            self.email,
        )
        self.assertTrue({"member", "email_address", "email_type"}.issubset(readonly))

    def test_primary_form_rejects_forged_identity_edit(self):
        form = ContactEmailAdminForm(
            data={
                "member": str(self.member.pk),
                "email_address": "rewritten@example.com",
                "email_type": "primary",
                "verified": "",
                "subscribe": "",
            },
            instance=self.email,
        )

        self.assertFalse(form.is_valid())
        self.assertIn("cannot be edited directly", str(form.non_field_errors()))

    def test_save_model_rejects_primary_demotion(self):
        self.email.email_type = "secondary"

        with self.assertRaisesMessage(PermissionDenied, "cannot be edited directly"):
            self.model_admin.save_model(
                _request(self.rf, self.admin_user),
                self.email,
                form=None,
                change=True,
            )

        self.email.refresh_from_db()
        self.assertEqual(self.email.email_type, "primary")

    def test_save_model_rejects_direct_primary_promotion(self):
        secondary = ContactEmail.objects.create(
            member=self.member,
            email_address="secondary@example.com",
            email_type="secondary",
            verified=True,
        )
        secondary.email_type = "primary"

        with self.assertRaisesMessage(PermissionDenied, "cannot be assigned directly"):
            self.model_admin.save_model(
                _request(self.rf, self.admin_user),
                secondary,
                form=None,
                change=True,
            )

        secondary.refresh_from_db()
        self.assertEqual(secondary.email_type, "secondary")

    def test_primary_cannot_be_deleted_directly_or_in_bulk(self):
        request = _request(self.rf, self.admin_user)
        self.assertFalse(self.model_admin.has_delete_permission(request, self.email))

        with self.assertRaisesMessage(PermissionDenied, "cannot be deleted directly"):
            self.model_admin.delete_model(request, self.email)
        with self.assertRaisesMessage(PermissionDenied, "cannot be deleted directly"):
            self.model_admin.delete_queryset(
                request,
                ContactEmail.objects.filter(pk=self.email.pk),
            )

        self.assertTrue(ContactEmail.objects.filter(pk=self.email.pk).exists())

    def test_make_primary_action_uses_atomic_swap_service(self):
        secondary = ContactEmail.objects.create(
            member=self.member,
            email_address="secondary@example.com",
            email_type="secondary",
            verified=True,
        )
        request = _request(self.rf, self.admin_user)

        self.model_admin.make_primary(
            request,
            ContactEmail.objects.filter(pk=secondary.pk),
        )

        self.email.refresh_from_db()
        secondary.refresh_from_db()
        self.assertEqual(self.email.email_type, "secondary")
        self.assertEqual(secondary.email_type, "primary")
        self.assertIn(
            "secondary@example.com is now the primary email.",
            self._messages(request),
        )

    def test_make_primary_action_requires_exactly_one_email(self):
        secondary = ContactEmail.objects.create(
            member=self.member,
            email_address="secondary@example.com",
            email_type="secondary",
            verified=True,
        )
        request = _request(self.rf, self.admin_user)

        self.model_admin.make_primary(
            request,
            ContactEmail.objects.filter(pk__in=(self.email.pk, secondary.pk)),
        )

        self.email.refresh_from_db()
        secondary.refresh_from_db()
        self.assertEqual(self.email.email_type, "primary")
        self.assertEqual(secondary.email_type, "secondary")
        self.assertIn("Select exactly one email to make primary.", self._messages(request))


class ContactPhoneAdminTests(_AdminTestBase):
    def setUp(self):
        super().setUp()
        self.model_admin = ContactPhoneAdmin(ContactPhone, self.site)
        self.member = Member.objects.create_user(password="t", first_name="C", last_name="P")
        self.phone = ContactPhone.objects.create(member=self.member, phone_number="2095551234", region="1-US")

    def test_get_formatted_number(self):
        result = self.model_admin.get_formatted_number(self.phone)
        self.assertTrue(result)

    def test_mark_verified(self):
        request = _request(self.rf, self.admin_user)
        self.model_admin.mark_verified(request, ContactPhone.objects.filter(pk=self.phone.pk))
        self.phone.refresh_from_db()
        self.assertTrue(self.phone.verified)
        self.assertIn("1 phone(s) marked as verified.", self._messages(request))

    def test_mark_unverified(self):
        self.phone.verified = True
        self.phone.save(update_fields=["verified"])
        request = _request(self.rf, self.admin_user)
        self.model_admin.mark_unverified(request, ContactPhone.objects.filter(pk=self.phone.pk))
        self.phone.refresh_from_db()
        self.assertFalse(self.phone.verified)
        self.assertIn("1 phone(s) marked as unverified.", self._messages(request))

    def test_normalize_all_phones_redirects_to_preview(self):
        request = _request(self.rf, self.admin_user)
        response = self.model_admin.normalize_all_phones(request, ContactPhone.objects.all())
        self.assertEqual(response.status_code, 302)
        self.assertIn("normalize-phones-preview", response.url)

    def test_normalize_preview_view(self):
        # store a number that needs normalization (E.164 with country code)
        ContactPhone.objects.create(member=self.member, phone_number="+12095559999", region="1-US")
        request = _request(self.rf, self.admin_user)
        response = self.model_admin._normalize_preview_view(request)
        self.assertEqual(response.status_code, 200)

    def test_normalize_apply_view_get_redirects(self):
        request = _request(self.rf, self.admin_user)
        response = self.model_admin._normalize_apply_view(request)
        self.assertEqual(response.status_code, 302)
        self.assertIn("normalize-phones-preview", response.url)

    def test_normalize_apply_view_post_applies(self):
        ContactPhone.objects.create(member=self.member, phone_number="+12095559999", region="1-US")
        request = _request(self.rf, self.admin_user, method="post")
        response = self.model_admin._normalize_apply_view(request)
        self.assertEqual(response.status_code, 302)
        self.assertIn("contactphone", response.url)
        self.assertTrue(self._messages(request))

    def test_normalize_apply_view_handles_exception(self):
        request = _request(self.rf, self.admin_user, method="post")
        with patch(
            "apps.authn.admin.members.contact.phone.apply_phone_changes",
            side_effect=RuntimeError("boom"),
        ):
            response = self.model_admin._normalize_apply_view(request)
        self.assertEqual(response.status_code, 302)
        self.assertIn("normalize-phones-preview", response.url)
        self.assertTrue(any("Failed to apply" in m for m in self._messages(request)))


class RSAKeypairAdminTests(_AdminTestBase):
    def setUp(self):
        super().setUp()
        self.model_admin = RSAKeypairAdmin(RSAKeypair, self.site)
        public_pem, private_pem = RSAKeypair.generate_keypair()
        self.keypair = RSAKeypair.objects.create(
            name="K1", public_key_pem=public_pem, private_key_pem=private_pem, is_active=True
        )

    def test_get_readonly_fields_for_existing(self):
        fields = self.model_admin.get_readonly_fields(None, obj=self.keypair)
        self.assertIn("private_key_pem", fields)
        self.assertIn("is_active", fields)

    def test_get_readonly_fields_for_new(self):
        fields = self.model_admin.get_readonly_fields(None, obj=None)
        self.assertEqual(fields, ("key_id",))

    def test_get_fieldsets_for_existing(self):
        fieldsets = self.model_admin.get_fieldsets(None, obj=self.keypair)
        self.assertEqual(len(fieldsets), 3)

    def test_get_fieldsets_for_new(self):
        fieldsets = self.model_admin.get_fieldsets(None, obj=None)
        self.assertEqual(len(fieldsets), 1)

    def test_deactivate_keypairs(self):
        request = _request(self.rf, self.admin_user)
        self.model_admin.deactivate_keypairs(request, RSAKeypair.objects.filter(pk=self.keypair.pk))
        self.keypair.refresh_from_db()
        self.assertFalse(self.keypair.is_active)
        self.assertIn("1 keypair(s) deactivated.", self._messages(request))

    def test_retired_keypairs_cannot_be_reactivated_from_admin(self):
        self.keypair.is_active = False
        self.keypair.save(update_fields=["is_active"])

        self.assertNotIn("activate_keypairs", self.model_admin.actions)
        self.assertFalse(hasattr(self.model_admin, "activate_keypairs"))
        self.keypair.refresh_from_db()
        self.assertFalse(self.keypair.is_active)

    def test_regenerate_keys(self):
        old_pub = self.keypair.public_key_pem
        request = _request(self.rf, self.admin_user)
        self.model_admin.regenerate_keys(request, RSAKeypair.objects.filter(pk=self.keypair.pk))
        self.keypair.refresh_from_db()
        replacement = RSAKeypair.objects.get(name=self.keypair.name, is_active=True)
        self.assertEqual(self.keypair.public_key_pem, old_pub)
        self.assertFalse(self.keypair.is_active)
        self.assertNotEqual(replacement.public_key_pem, old_pub)
        self.assertIn("1 keypair(s) regenerated.", self._messages(request))


class AdminInvitationAdminTests(_AdminTestBase):
    def setUp(self):
        super().setUp()
        self.model_admin = AdminInvitationAdmin(AdminInvitation, self.site)

    def _make_invitation(self, status=None, expires_delta_days=7):
        from django.utils import timezone

        return AdminInvitation.objects.create(
            email="invitee@example.com",
            role=AdminInvitation.Role.ADMIN,
            token=AdminInvitation.generate_token(),
            invited_by=self.admin_user,
            status=status or AdminInvitation.Status.PENDING,
            expires_at=timezone.now() + timezone.timedelta(days=expires_delta_days),
        )

    def test_get_fieldsets_add(self):
        fieldsets = self.model_admin.get_fieldsets(None, obj=None)
        self.assertEqual(len(fieldsets), 1)

    def test_get_fieldsets_change(self):
        inv = self._make_invitation()
        fieldsets = self.model_admin.get_fieldsets(None, obj=inv)
        self.assertEqual(len(fieldsets), 3)

    def test_get_readonly_fields_change_locks_email(self):
        inv = self._make_invitation()
        fields = self.model_admin.get_readonly_fields(None, obj=inv)
        self.assertIn("email", fields)

    def test_get_readonly_fields_add(self):
        fields = self.model_admin.get_readonly_fields(None, obj=None)
        self.assertNotIn("email", fields)

    def test_status_badge_pending(self):
        inv = self._make_invitation()
        html = self.model_admin.status_badge(inv)
        self.assertIn("span", html)

    def test_status_badge_expired_pending(self):
        inv = self._make_invitation(expires_delta_days=-1)
        html = self.model_admin.status_badge(inv)
        self.assertIn("span", html)

    @patch("apps.authn.services.email.send_admin_invitation_email")
    def test_save_model_new_sends_invitation(self, mock_send):
        request = _request(self.rf, self.admin_user, method="post")
        inv = AdminInvitation(email="New@Example.com", role=AdminInvitation.Role.ADMIN)
        self.model_admin.save_model(request, inv, form=None, change=False)
        inv.refresh_from_db()
        self.assertEqual(inv.email, "new@example.com")
        self.assertTrue(inv.token)
        mock_send.assert_called_once()
        self.assertTrue(any("created and sent" in m for m in self._messages(request)))

    @patch(
        "apps.authn.services.email.send_admin_invitation_email",
        side_effect=RuntimeError("smtp down"),
    )
    def test_save_model_new_email_failure_warns(self, mock_send):
        request = _request(self.rf, self.admin_user, method="post")
        inv = AdminInvitation(email="fail@example.com", role=AdminInvitation.Role.ADMIN)
        self.model_admin.save_model(request, inv, form=None, change=False)
        self.assertTrue(any("could not be sent" in m for m in self._messages(request)))

    def test_save_model_change_does_not_resend(self):
        inv = self._make_invitation()
        request = _request(self.rf, self.admin_user, method="post")
        with patch("apps.authn.services.email.send_admin_invitation_email") as mock_send:
            self.model_admin.save_model(request, inv, form=None, change=True)
        mock_send.assert_not_called()

    @patch("apps.authn.services.email.send_admin_invitation_email")
    def test_resend_invitations_sends_and_skips(self, mock_send):
        valid = self._make_invitation()
        expired = self._make_invitation(expires_delta_days=-1)
        request = _request(self.rf, self.admin_user)
        self.model_admin.resend_invitations(request, AdminInvitation.objects.filter(pk__in=[valid.pk, expired.pk]))
        expired.refresh_from_db()
        self.assertEqual(expired.status, AdminInvitation.Status.EXPIRED)
        msgs = self._messages(request)
        self.assertTrue(any("Skipped" in m for m in msgs))
        self.assertTrue(any("Resent" in m for m in msgs))

    def test_cancel_invitations(self):
        inv = self._make_invitation()
        request = _request(self.rf, self.admin_user)
        self.model_admin.cancel_invitations(request, AdminInvitation.objects.filter(pk=inv.pk))
        inv.refresh_from_db()
        self.assertEqual(inv.status, AdminInvitation.Status.CANCELLED)
        self.assertTrue(any("Cancelled" in m for m in self._messages(request)))


class MemberSheetSyncAdminTests(_AdminTestBase):
    def setUp(self):
        super().setUp()
        self.config_admin = MemberSheetSyncConfigAdmin(MemberSheetSyncConfig, self.site)
        self.log_admin = MemberSheetSyncLogAdmin(MemberSheetSyncLog, self.site)

    def test_sync_error_short_empty(self):
        config = MemberSheetSyncConfig(sync_error="")
        self.assertEqual(self.config_admin.sync_error_short(config), "")

    def test_sync_error_short_truncates(self):
        config = MemberSheetSyncConfig(sync_error="x" * 200)
        html = self.config_admin.sync_error_short(config)
        self.assertIn("span", html)

    def test_log_status_badge_success(self):
        log = MemberSheetSyncLog(status=MemberSheetSyncLog.Status.SUCCESS, sync_type="full", rows_written=3)
        html = self.log_admin.status_badge(log)
        self.assertIn("green", html)

    def test_log_status_badge_failure(self):
        log = MemberSheetSyncLog(status=MemberSheetSyncLog.Status.FAILED, sync_type="full", rows_written=0)
        html = self.log_admin.status_badge(log)
        self.assertIn("red", html)

    def test_error_message_short_empty(self):
        log = MemberSheetSyncLog(error_message="")
        self.assertEqual(self.log_admin.error_message_short(log), "")

    def test_error_message_short_truncates(self):
        log = MemberSheetSyncLog(error_message="e" * 200)
        self.assertEqual(len(self.log_admin.error_message_short(log)), 100)
