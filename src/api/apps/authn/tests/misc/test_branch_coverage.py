"""Focused branch coverage for current authn behavior."""

from __future__ import annotations

import argparse
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django import forms
from django.contrib import admin
from django.contrib.admin.sites import AdminSite
from django.contrib.auth import get_user_model
from django.contrib.messages.storage.fallback import FallbackStorage
from django.core.exceptions import ValidationError
from django.core.management.base import CommandError
from django.http import QueryDict
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from apps.authn.models import AdminInvitation, ContactEmail, ImpersonationToken, RSAKeypair

Member = get_user_model()


def _member(*, email: str | None = None, verified: bool = True, **kwargs):
    member = Member.objects.create_user(password="StrongPass123!", **kwargs)
    if email is not None:
        ContactEmail.objects.create(
            member=member,
            email_address=email,
            email_type="primary",
            verified=verified,
        )
    return member


def _request(user, *, method="get", data=None):
    request = getattr(RequestFactory(), method)("/admin/", data or {})
    request.user = user
    request.session = {}
    request._messages = FallbackStorage(request)
    return request


class ContactAdminPureBranchTests(SimpleTestCase):
    def test_primary_identity_change_checks_each_identity_component(self):
        from apps.authn.admin.members.contact.email import _primary_identity_changed

        current = SimpleNamespace(member_id=1, email_address="a@example.com", email_type="primary")
        self.assertFalse(_primary_identity_changed(current, current))
        self.assertTrue(
            _primary_identity_changed(
                current,
                SimpleNamespace(
                    member_id=2, email_address=current.email_address, email_type=current.email_type
                ),
            )
        )
        self.assertTrue(
            _primary_identity_changed(
                current,
                SimpleNamespace(
                    member_id=1, email_address="b@example.com", email_type=current.email_type
                ),
            )
        )
        self.assertTrue(
            _primary_identity_changed(
                current,
                SimpleNamespace(
                    member_id=1, email_address=current.email_address, email_type="secondary"
                ),
            )
        )


class ContactEmailAdminBranchTests(TestCase):
    def setUp(self):
        from apps.authn.admin.members.contact.email import ContactEmailAdmin

        self.site = AdminSite()
        self.admin_user = _member(
            email="admin@example.com",
            is_active=True,
            is_staff=True,
            is_superuser=True,
        )
        self.member = _member(is_active=True)
        self.model_admin = ContactEmailAdmin(ContactEmail, self.site)

    def test_admin_form_accepts_new_or_missing_instance_and_rejects_direct_promotion(self):
        from apps.authn.admin.members.contact.email import ContactEmailAdminForm

        new_form = ContactEmailAdminForm(
            data={
                "member": str(self.member.pk),
                "email_address": "new@example.com",
                "email_type": "secondary",
                "verified": "",
                "subscribe": "on",
            }
        )
        self.assertTrue(new_form.is_valid(), new_form.errors)

        missing = ContactEmail(
            pk=uuid.uuid4(),
            member=self.member,
            email_address="missing@example.com",
            email_type="secondary",
        )
        missing_form = ContactEmailAdminForm(
            data={
                "member": str(self.member.pk),
                "email_address": "missing@example.com",
                "email_type": "secondary",
                "verified": "",
                "subscribe": "on",
            },
            instance=missing,
        )
        self.assertTrue(missing_form.is_valid(), missing_form.errors)

        secondary = ContactEmail.objects.create(
            member=self.member,
            email_address="secondary@example.com",
            email_type="secondary",
            verified=True,
        )
        promotion = ContactEmailAdminForm(
            data={
                "member": str(self.member.pk),
                "email_address": secondary.email_address,
                "email_type": "primary",
                "verified": "on",
                "subscribe": "on",
            },
            instance=secondary,
        )
        self.assertFalse(promotion.is_valid())
        self.assertIn("cannot be assigned directly", str(promotion.non_field_errors()))

        unchanged = ContactEmailAdminForm(
            data={
                "member": str(self.member.pk),
                "email_address": secondary.email_address,
                "email_type": "secondary",
                "verified": "on",
                "subscribe": "on",
            },
            instance=secondary,
        )
        self.assertTrue(unchanged.is_valid(), unchanged.errors)

        unsaved = ContactEmailAdminForm(
            data={
                "member": str(self.member.pk),
                "email_address": "unsaved@example.com",
                "email_type": "secondary",
                "verified": "",
                "subscribe": "on",
            }
        )
        unsaved.instance.pk = None
        self.assertTrue(unsaved.is_valid(), unsaved.errors)

    def test_readonly_and_delete_permissions_for_non_primary_or_no_object(self):
        request = _request(self.admin_user)
        secondary = ContactEmail.objects.create(
            member=self.member,
            email_address="secondary@example.com",
            email_type="secondary",
        )
        self.assertNotIn("member", self.model_admin.get_readonly_fields(request, None))
        self.assertNotIn("member", self.model_admin.get_readonly_fields(request, secondary))
        self.assertTrue(self.model_admin.has_delete_permission(request, secondary))

        primary = ContactEmail.objects.create(
            member=self.member,
            email_address="primary@example.com",
            email_type="primary",
        )
        from apps.core.admin import BaseModelAdmin

        with patch.object(BaseModelAdmin, "get_readonly_fields", return_value=["member"]):
            readonly = self.model_admin.get_readonly_fields(request, primary)
        self.assertEqual(readonly.count("member"), 1)
        self.assertIn("email_address", readonly)

    def test_save_model_handles_add_missing_row_unowned_and_regular_update(self):
        request = _request(self.admin_user, method="post")
        added = ContactEmail(
            member=self.member,
            email_address="added@example.com",
            email_type="secondary",
        )
        self.model_admin.save_model(request, added, form=None, change=False)
        self.assertTrue(ContactEmail.objects.filter(pk=added.pk).exists())

        missing = ContactEmail(
            pk=uuid.uuid4(),
            member=self.member,
            email_address="missing@example.com",
            email_type="secondary",
        )
        self.model_admin.save_model(request, missing, form=None, change=True)
        self.assertTrue(ContactEmail.objects.filter(pk=missing.pk).exists())

        unowned = ContactEmail.objects.create(
            member=None,
            email_address="unowned@example.com",
            email_type="other",
            subscribe=True,
        )
        unowned.subscribe = False
        self.model_admin.save_model(request, unowned, form=None, change=True)
        unowned.refresh_from_db()
        self.assertFalse(unowned.subscribe)

        regular = ContactEmail.objects.create(
            member=self.member,
            email_address="regular@example.com",
            email_type="other",
            subscribe=True,
        )
        regular.subscribe = False
        self.model_admin.save_model(request, regular, form=None, change=True)
        regular.refresh_from_db()
        self.assertFalse(regular.subscribe)

    def test_delete_model_handles_missing_and_unowned_non_primary(self):
        request = _request(self.admin_user)
        missing = ContactEmail(pk=uuid.uuid4(), email_address="missing@example.com")
        self.model_admin.delete_model(request, missing)

        unowned = ContactEmail.objects.create(
            member=None, email_address="unowned@example.com", email_type="other"
        )
        self.model_admin.delete_model(request, unowned)
        self.assertFalse(ContactEmail.objects.filter(pk=unowned.pk).exists())

    def test_delete_queryset_handles_empty_and_non_primary_rows(self):
        request = _request(self.admin_user)
        self.model_admin.delete_queryset(request, ContactEmail.objects.none())

        owned = ContactEmail.objects.create(
            member=self.member, email_address="owned@example.com", email_type="other"
        )
        unowned = ContactEmail.objects.create(
            member=None, email_address="unowned@example.com", email_type="other"
        )
        self.model_admin.delete_queryset(
            request, ContactEmail.objects.filter(pk__in=[owned.pk, unowned.pk])
        )
        self.assertFalse(ContactEmail.objects.filter(pk__in=[owned.pk, unowned.pk]).exists())

    def test_make_primary_handles_missing_owner_and_service_error(self):
        request = _request(self.admin_user)
        fake_queryset = MagicMock()
        fake_queryset.count.return_value = 1
        fake_queryset.select_related.return_value.first.return_value = None
        self.model_admin.make_primary(request, fake_queryset)

        unowned = ContactEmail.objects.create(
            member=None, email_address="unowned@example.com", email_type="other"
        )
        self.model_admin.make_primary(request, ContactEmail.objects.filter(pk=unowned.pk))

        unverified = ContactEmail.objects.create(
            member=self.member,
            email_address="unverified@example.com",
            email_type="secondary",
            verified=False,
        )
        self.model_admin.make_primary(request, ContactEmail.objects.filter(pk=unverified.pk))
        messages = [str(message) for message in request._messages]
        self.assertTrue(any("must belong to a member" in message for message in messages))
        self.assertTrue(any("Verify this email" in message for message in messages))


class AdminFormsAndHelpersBranchTests(TestCase):
    def test_admin_app_choices_falls_back_to_label(self):
        from apps.authn.admin.members.forms import admin_app_choices

        fake_model = type("FakeModel", (), {"_meta": SimpleNamespace(app_label="missing_app")})
        with (
            patch.object(admin.site, "_registry", {fake_model: object()}),
            patch(
                "apps.authn.admin.members.forms.django_apps.get_app_config",
                side_effect=LookupError,
            ),
        ):
            self.assertEqual(admin_app_choices(), [("missing_app", "missing_app (missing_app)")])

    def test_member_creation_init_tolerates_parent_without_usable_password(self):
        from apps.authn.admin.members.forms import MemberCreationForm, UserCreationForm

        def fake_parent_init(form, *_args, **_kwargs):
            form.fields = {"password1": forms.CharField(), "password2": forms.CharField()}

        with patch.object(UserCreationForm, "__init__", new=fake_parent_init):
            form = MemberCreationForm()
        self.assertNotIn("usable_password", form.fields)

    def test_import_form_clean_handles_no_file(self):
        from apps.authn.admin.members.forms import MemberImportForm

        form = MemberImportForm()
        form.cleaned_data = {}
        self.assertIsNone(form.clean_excel_file())

    def test_normalize_inline_values_exercises_skip_and_immutable_paths(self):
        from apps.authn.admin.members.helpers import normalize_inline_uuid_none_values

        get_request = RequestFactory().get("/")
        normalize_inline_uuid_none_values(get_request)

        class Data:
            def __init__(self):
                self.values = {
                    "unrelated-0-id": ["None"],
                    "contact_emails-0-email": ["None"],
                    "contact_emails-0-id": ["already-valid"],
                }

            def lists(self):
                return self.values.items()

            def setlist(self, key, values):
                self.values[key] = values

        request = SimpleNamespace(method="POST", POST=Data())
        normalize_inline_uuid_none_values(request)
        self.assertEqual(request.POST.values["contact_emails-0-id"], ["already-valid"])

    def test_import_view_invalid_form_and_unsuccessful_result_do_not_message(self):
        from apps.authn.admin.members import helpers

        class FakeAdmin:
            model = Member
            admin_site = SimpleNamespace(each_context=lambda _request: {})

            def has_view_permission(self, request, obj=None):
                return True

            def message_user(self, request, message, level=None):
                raise AssertionError("no message expected")

        request = RequestFactory().post("/", {})
        with (
            patch.object(helpers, "MemberImportForm") as form_class,
            patch.object(helpers, "render", return_value="rendered"),
            patch.object(helpers, "build_import_context", return_value={}),
        ):
            form_class.return_value.is_valid.return_value = False
            self.assertEqual(helpers.import_excel_view(FakeAdmin(), request), "rendered")

        failed = SimpleNamespace(success=False)
        with (
            patch.object(helpers, "MemberImportForm") as form_class,
            patch.object(helpers, "render", return_value="rendered"),
            patch.object(helpers, "build_import_context", return_value={}),
            patch(
                "apps.authn.services.members.import_.import_members_from_excel",
                return_value=failed,
            ),
        ):
            form = form_class.return_value
            form.is_valid.return_value = True
            form.cleaned_data = {
                "excel_file": object(),
                "set_password": "password",
                "update_existing": False,
            }
            self.assertEqual(helpers.import_excel_view(FakeAdmin(), request), "rendered")


class InlineAndAdminLoopBranchTests(TestCase):
    def test_model_choice_field_parses_real_pk_and_normalizer_skips_other_keys(self):
        from apps.authn.admin.members.inlines import (
            NoneSafeModelChoiceField,
            NoneSafeUUIDInlineFormSet,
        )

        member = _member()
        field = NoneSafeModelChoiceField(queryset=Member.objects.all())
        self.assertEqual(field.to_python(str(member.pk)), member)

        data = QueryDict(mutable=True)
        data.setlist("other-0-id", ["None"])
        data.setlist("contact_emails-0-email_address", ["None"])
        data.setlist("contact_emails-0-id", [str(uuid.uuid4())])
        normalized = NoneSafeUUIDInlineFormSet._normalize_none_uuid_values(data, "contact_emails")
        self.assertEqual(normalized.getlist("other-0-id"), ["None"])
        self.assertEqual(normalized.getlist("contact_emails-0-email_address"), ["None"])

    def test_inline_clean_skips_form_without_cleaned_data(self):
        from unfold.admin import TabularInline

        from apps.authn.admin.members.inlines import ContactEmailInline

        class FakeFormset:
            def clean(self):
                return None

        inline = ContactEmailInline(Member, AdminSite())
        request = _request(_member(is_staff=True, admin_apps=["authn"]))
        with patch.object(TabularInline, "get_formset", return_value=FakeFormset):
            inline.get_formset(request)
        formset = FakeFormset()
        formset.instance = SimpleNamespace(pk=None, _state=SimpleNamespace(adding=True))
        formset.forms = [SimpleNamespace(instance=SimpleNamespace(pk=None))]
        with self.assertRaises(AttributeError):
            formset.clean()

    def test_inline_add_fields_handles_absent_fields_and_clean_accepts_non_primary(self):
        from django.forms.models import BaseInlineFormSet
        from unfold.admin import TabularInline

        from apps.authn.admin.members.inlines import (
            ContactEmailInline,
            NoneSafeUUIDInlineFormSet,
        )

        formset = object.__new__(NoneSafeUUIDInlineFormSet)
        formset.fk = SimpleNamespace(name="member")
        form = SimpleNamespace(fields={})
        with patch.object(BaseInlineFormSet, "add_fields", return_value=None):
            formset.add_fields(form, 0)

        member = _member()
        contact = ContactEmail.objects.create(
            member=member,
            email_address="other@example.com",
            email_type="other",
        )

        class FakeFormset:
            def clean(self):
                return None

        inline = ContactEmailInline(Member, AdminSite())
        request = _request(_member(is_staff=True, admin_apps=["authn"]))
        with patch.object(TabularInline, "get_formset", return_value=FakeFormset):
            formset_class = inline.get_formset(request)
        nested = FakeFormset()
        nested.instance = SimpleNamespace(pk=None, _state=SimpleNamespace(adding=True))
        nested.forms = [
            SimpleNamespace(
                instance=contact,
                cleaned_data={"DELETE": False, "email_type": "other"},
                changed_data=[],
                is_bound=True,
                data={},
                add_prefix=lambda name: name,
            )
        ]
        formset_class.clean(nested)

    def test_member_readonly_loop_skips_field_already_readonly(self):
        from apps.authn.admin.members.member import MemberAdmin
        from apps.core.admin import BaseModelAdmin

        user = _member(is_staff=True, is_superuser=False, admin_apps=["authn"])
        model_admin = MemberAdmin(Member, AdminSite())
        with patch.object(BaseModelAdmin, "get_readonly_fields", return_value=["is_staff"]):
            readonly = model_admin.get_readonly_fields(_request(user))
        self.assertEqual(readonly.count("is_staff"), 1)
        self.assertIn("admin_apps", readonly)

    def test_rsa_regenerate_skips_inactive_key(self):
        from apps.authn.admin.security import RSAKeypairAdmin

        admin_user = _member(is_staff=True, is_superuser=True)
        key = RSAKeypair.objects.create(
            name="inactive",
            public_key_pem="public",
            private_key_pem="private",
            is_active=False,
        )
        model_admin = RSAKeypairAdmin(RSAKeypair, AdminSite())
        with patch.object(RSAKeypair, "rotate") as rotate:
            model_admin.regenerate_keys(_request(admin_user), RSAKeypair.objects.filter(pk=key.pk))
        rotate.assert_not_called()


class InvitationBranchTests(TestCase):
    def test_resend_delivery_failure_does_not_report_sent_or_skipped(self):
        from apps.authn.admin.members.invitation import AdminInvitationAdmin

        staff = _member(is_active=True, is_staff=True, is_superuser=True)
        invitation = AdminInvitation.objects.create(
            email="invitee@example.com",
            role=AdminInvitation.Role.ADMIN,
            token=AdminInvitation.generate_token(),
            invited_by=staff,
            status=AdminInvitation.Status.PENDING,
            expires_at=timezone.now() + timezone.timedelta(days=1),
        )
        request = _request(staff)
        model_admin = AdminInvitationAdmin(AdminInvitation, AdminSite())
        with patch(
            "apps.authn.services.email.send_admin_invitation_email",
            side_effect=RuntimeError("provider down"),
        ):
            model_admin.resend_invitations(
                request, AdminInvitation.objects.filter(pk=invitation.pk)
            )
        messages = [str(message) for message in request._messages]
        self.assertEqual(len(messages), 1)
        self.assertIn("could not be sent", messages[0])


class ModelBranchTests(TestCase):
    def test_contact_clean_distinguishes_duplicate_owner_and_other_owner(self):
        owner = _member()
        other = _member()
        ContactEmail.objects.create(
            member=owner, email_address="duplicate@example.com", email_type="primary"
        )
        same_owner = ContactEmail(
            member=owner,
            email_address=" duplicate@example.com ",
            email_type="secondary",
        )
        with self.assertRaisesMessage(ValidationError, "already has this email"):
            same_owner.clean()

        other_owner = ContactEmail(
            member=other,
            email_address="duplicate@example.com",
            email_type="secondary",
        )
        with self.assertRaisesMessage(ValidationError, "another member"):
            other_owner.clean()

    def test_contact_clean_empty_address_existing_primary_and_str_flags(self):
        member = _member()
        blank = ContactEmail(member=member, email_address="", email_type="other")
        blank.clean()

        primary = ContactEmail.objects.create(
            member=member,
            email_address="primary@example.com",
            email_type="primary",
            subscribe=False,
            verified=False,
        )
        primary.email_address = "primary@example.com"
        primary.clean()
        duplicate_primary = ContactEmail(
            member=member,
            email_address="another@example.com",
            email_type="primary",
        )
        with self.assertRaisesMessage(ValidationError, "already has a primary"):
            duplicate_primary.clean()
        self.assertNotIn("Subscribed", str(primary))
        self.assertNotIn("Verified", str(primary))

        no_pk_primary = ContactEmail(
            member=member,
            email_address="no-pk@example.com",
            email_type="primary",
        )
        no_pk_primary.pk = None
        with self.assertRaisesMessage(ValidationError, "already has a primary"):
            no_pk_primary.clean()

    def test_prefetched_contacts_without_primary_return_none(self):
        member = _member()
        other = ContactEmail.objects.create(
            member=member,
            email_address="other@example.com",
            email_type="other",
        )
        member._prefetched_objects_cache = {"contact_emails": [other]}
        self.assertIsNone(member._primary_contact_from_prefetch())

    def test_impersonation_validity_short_circuits_used_and_expired_tokens(self):
        creator = _member()
        target = _member()
        used = ImpersonationToken(
            member=target,
            created_by=creator,
            token="used",
            is_used=True,
            expires_at=timezone.now() + timezone.timedelta(minutes=1),
        )
        expired = ImpersonationToken(
            member=target,
            created_by=creator,
            token="expired",
            expires_at=timezone.now() - timezone.timedelta(minutes=1),
        )
        self.assertFalse(used.is_valid)
        self.assertFalse(expired.is_valid)

    def test_inactive_rsa_key_cannot_rotate_and_partial_keys_are_regenerated(self):
        inactive = RSAKeypair.objects.create(
            name="inactive-model",
            public_key_pem="public",
            private_key_pem="private",
            is_active=False,
        )
        with self.assertRaisesMessage(ValueError, "Only an active"):
            inactive.rotate()

        active = RSAKeypair.objects.create(
            name="partial-model",
            public_key_pem="public",
            private_key_pem="private",
            is_active=True,
        )
        with patch.object(
            RSAKeypair, "generate_keypair", return_value=("new-public", "new-private")
        ):
            replacement = active.rotate(public_key_pem="provided", private_key_pem=None)
        self.assertEqual(replacement.public_key_pem, "new-public")

        second = RSAKeypair.objects.create(
            name="provided-model",
            public_key_pem="old-public",
            private_key_pem="old-private",
            is_active=True,
        )
        provided = second.rotate(
            public_key_pem="provided-public",
            private_key_pem="provided-private",
        )
        self.assertEqual(provided.public_key_pem, "provided-public")


class InvitationFormBranchTests(SimpleTestCase):
    def test_clean_without_valid_password_skips_password_validation(self):
        from apps.authn.forms.invitation import AcceptInvitationForm

        form = AcceptInvitationForm(data={})
        self.assertFalse(form.is_valid())
        self.assertIn("password1", form.errors)


class SecurityHelperBranchTests(SimpleTestCase):
    def test_normalization_hashing_decision_and_rate_limit_stub(self):
        from apps.authn.security.helpers import (
            AuthRateThrottle,
            RateLimitDecision,
            consume_request_rate_limit,
            normalize_security_identity,
            security_log_key,
        )

        self.assertEqual(normalize_security_identity(" User@Example.COM "), "user@example.com")
        self.assertEqual(len(security_log_key("user@example.com")), 16)
        decision = RateLimitDecision(allowed=False, retry_after=12)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.retry_after, 12)
        self.assertTrue(
            consume_request_rate_limit("login", object(), identity="user@example.com").allowed
        )
        self.assertTrue(consume_request_rate_limit("login", object()).allowed)
        self.assertTrue(AuthRateThrottle().allow_request(object(), object()))

    @override_settings(
        AUTH_TRUSTED_PROXY_COUNT=0,
        AUTH_TRUSTED_PROXY_CIDR_HOPS=0,
        AUTH_TRUSTED_PROXY_CIDRS=[],
    )
    def test_client_ip_falls_back_to_remote_address(self):
        from apps.authn.security.helpers import client_ip

        request = SimpleNamespace(META={"REMOTE_ADDR": "198.51.100.9"})
        self.assertEqual(client_ip(request), "198.51.100.9")

    @override_settings(
        FRONTEND_URL="https://frontend.example.com",
        BACKEND_URL="",
        CSRF_TRUSTED_ORIGINS=[],
    )
    def test_cookie_origin_accepts_configured_origin_and_rejects_other_origin(self):
        from rest_framework.exceptions import PermissionDenied as DrfPermissionDenied

        from apps.authn.security.helpers import enforce_cookie_request_origin

        allowed = RequestFactory().post("/", HTTP_ORIGIN="https://frontend.example.com")
        enforce_cookie_request_origin(allowed)
        absent = RequestFactory().post("/")
        enforce_cookie_request_origin(absent)
        rejected = RequestFactory().post("/", HTTP_ORIGIN="https://evil.example.com")
        with self.assertRaises(DrfPermissionDenied):
            enforce_cookie_request_origin(rejected)

    @override_settings(
        AUTH_TRUSTED_PROXY_COUNT=0,
        AUTH_TRUSTED_PROXY_CIDR_HOPS=2,
        AUTH_TRUSTED_PROXY_CIDRS="not-a-cidr, 10.0.0.0/8",
    )
    def test_client_ip_walks_trusted_cidr_chain_and_handles_invalid_hops(self):
        from apps.authn.security.helpers import client_ip

        trusted = SimpleNamespace(
            META={
                "HTTP_X_FORWARDED_FOR": "203.0.113.8, 10.1.1.1, 10.2.2.2",
                "REMOTE_ADDR": "127.0.0.1",
            }
        )
        self.assertEqual(client_ip(trusted), "203.0.113.8")

        invalid = SimpleNamespace(
            META={
                "HTTP_X_FORWARDED_FOR": "203.0.113.8, invalid",
                "REMOTE_ADDR": "127.0.0.1",
            }
        )
        self.assertEqual(client_ip(invalid), "unknown")

        untrusted = SimpleNamespace(
            META={
                "HTTP_X_FORWARDED_FOR": "203.0.113.8, 192.0.2.1",
                "REMOTE_ADDR": "127.0.0.1",
            }
        )
        self.assertEqual(client_ip(untrusted), "192.0.2.1")

    @override_settings(AUTH_TRUSTED_PROXY_COUNT=2, AUTH_TRUSTED_PROXY_CIDR_HOPS=0)
    def test_client_ip_uses_proxy_count_and_rejects_malformed_candidate(self):
        from apps.authn.security.helpers import client_ip

        request = SimpleNamespace(
            META={"HTTP_X_FORWARDED_FOR": "bad, 10.0.0.1", "REMOTE_ADDR": "127.0.0.1"}
        )
        self.assertEqual(client_ip(request), "unknown")

    def test_rate_throttle_wait_returns_retry_after(self):
        from apps.authn.security.helpers import AuthRateThrottle

        throttle = AuthRateThrottle()
        throttle.retry_after = 9
        self.assertEqual(throttle.wait(), 9)


class SecurityPruningBranchTests(TestCase):
    def test_prune_security_state_updates_and_deletes_all_retained_state(self):
        from apps.authn.security.helpers import prune_auth_security_state

        member = _member()
        challenge = __import__(
            "apps.authn.models", fromlist=["EmailAuthChallenge"]
        ).EmailAuthChallenge.objects.create(
            member=member,
            purpose="login",
            target_email="expired@example.com",
            code_hash="hash",
            expires_at=timezone.now() - timezone.timedelta(minutes=1),
            status="pending",
        )
        jobs = MagicMock()
        jobs.update.return_value = 2
        temp_sessions = MagicMock()
        temp_sessions.delete.return_value = (3, {})
        temp_model = SimpleNamespace(objects=MagicMock())
        temp_model.objects.filter.return_value = temp_sessions
        tokens = MagicMock()
        tokens.delete.return_value = (4, {})

        now = timezone.now()
        with (
            patch("django.apps.apps.get_model", return_value=temp_model),
            patch("apps.mail.models.EmailDeliveryJob.objects.filter", return_value=jobs),
            patch(
                "rest_framework_simplejwt.token_blacklist.models.OutstandingToken.objects.filter",
                return_value=tokens,
            ),
        ):
            result = prune_auth_security_state(now=now)

        challenge.refresh_from_db()
        self.assertEqual(challenge.status, "expired")
        self.assertEqual(result["authChallenges"], 1)
        self.assertEqual(result["authEmailJobs"], 2)
        self.assertEqual(result["temporaryEventSessions"], 3)
        self.assertEqual(result["outstandingTokens"], 4)


class EnsureDefaultAdminBranchTests(TestCase):
    def test_missing_email_and_blank_password_env_name_are_rejected(self):
        from apps.authn.management.ensure_default_admin import Command

        command = Command()
        with self.assertRaisesMessage(CommandError, "email"):
            command.handle(
                yes=True,
                email="",
                password_env="PASSWORD",
                first_name="First",
                last_name="Last",
            )
        with self.assertRaisesMessage(CommandError, "password-env"):
            command.handle(
                yes=True,
                email="admin@example.com",
                password_env=" ",
                first_name="First",
                last_name="Last",
            )

    def test_concurrent_claim_without_valid_owner_is_rejected(self):
        from apps.authn.management.ensure_default_admin import Command, _ConcurrentAdminCreated

        command = Command()
        with (
            patch.object(command, "_create_member", side_effect=_ConcurrentAdminCreated),
            patch.object(command, "_find_contact_for_update", return_value=None),
            patch.dict("os.environ", {"PASSWORD": "StrongPass123!"}),
            self.assertRaisesMessage(CommandError, "claimed concurrently"),
        ):
            command.handle(
                yes=True,
                email="race@example.com",
                password_env="PASSWORD",
                first_name="First",
                last_name="Last",
            )


class MigrateLockedBranchTests(SimpleTestCase):
    def test_add_arguments_registers_lock_timeout(self):
        from apps.authn.management.migrate_locked import Command

        parser = argparse.ArgumentParser()
        Command().add_arguments(parser)
        options = parser.parse_args(["--lock-timeout-seconds", "7"])
        self.assertEqual(options.lock_timeout_seconds, 7)

    def test_negative_timeout_is_rejected(self):
        from apps.authn.management.migrate_locked import Command

        with self.assertRaisesMessage(CommandError, "non-negative"):
            Command().handle(database="default", lock_timeout_seconds=-1)

    def test_waits_then_acquires_and_warns_if_release_is_false(self):
        from django.core.management.commands.migrate import Command as MigrateCommand

        from apps.authn.management import migrate_locked
        from apps.authn.tests.commands.test_migrate_locked import _Connection

        connection = _Connection(acquire_results=(False, True), release_result=False)
        command = migrate_locked.Command()
        command.stderr = MagicMock()
        with (
            patch.object(migrate_locked, "connections", {"default": connection}),
            patch.object(migrate_locked.time, "monotonic", side_effect=[0, 0, 0]),
            patch.object(migrate_locked.time, "sleep") as sleep,
            patch.object(MigrateCommand, "handle", return_value="done"),
        ):
            self.assertEqual(command.handle(database="default", lock_timeout_seconds=10), "done")
        sleep.assert_called_once()
        command.stderr.write.assert_called_once()

    def test_lost_connection_needs_no_explicit_unlock(self):
        from django.core.management.commands.migrate import Command as MigrateCommand

        from apps.authn.management import migrate_locked
        from apps.authn.tests.commands.test_migrate_locked import _Connection

        connection = _Connection()
        connection.connection = None
        command = migrate_locked.Command()
        with (
            patch.object(migrate_locked, "connections", {"default": connection}),
            patch.object(MigrateCommand, "handle", return_value="done"),
        ):
            self.assertEqual(command.handle(database="default", lock_timeout_seconds=0), "done")
        self.assertEqual(len(connection.calls), 1)
