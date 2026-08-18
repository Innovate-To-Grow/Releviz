"""Focused coverage for authn serializers and service edge behavior."""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone
from rest_framework import serializers

from apps.authn.models import ContactEmail, EmailAuthChallenge, RSAKeypair

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


def _challenge(member, *, code="123456", purpose=EmailAuthChallenge.Purpose.LOGIN, **kwargs):
    values = {
        "member": member,
        "purpose": purpose,
        "target_email": "user@example.com",
        "code_hash": make_password(code),
        "expires_at": timezone.now() + timedelta(minutes=5),
        "max_attempts": 5,
        "last_sent_at": timezone.now(),
        "status": EmailAuthChallenge.Status.PENDING,
    }
    values.update(kwargs)
    return EmailAuthChallenge.objects.create(**values)


class SerializerBranchTests(TestCase):
    def test_profile_update_subscription_without_primary_is_a_noop(self):
        from apps.authn.serializers.account.profile import ProfileSerializer

        member = _member(first_name="Before")
        result = ProfileSerializer().update(
            member, {"email_subscribe": False, "first_name": "After"}
        )
        self.assertEqual(result.first_name, "After")

    def test_register_create_wraps_django_password_validation_error(self):
        from apps.authn.serializers.auth.register import RegisterSerializer

        serializer = RegisterSerializer()
        with patch(
            "apps.authn.serializers.auth.register.validate_password",
            side_effect=DjangoValidationError(["rejected"]),
        ):
            with self.assertRaises(serializers.ValidationError) as raised:
                serializer.create(
                    {
                        "email": "new@example.com",
                        "_decrypted_password": "StrongPass123!",
                        "first_name": "New",
                        "last_name": "Member",
                    }
                )
        self.assertIn("password", raised.exception.detail)

    def test_temporary_event_identity_requires_event_and_active_member(self):
        from apps.authn.serializers.email_code.auth import _event_registration_temporary_member

        member = _member(
            email="temporary@example.com",
            verified=False,
            access_level=Member.AccessLevel.TEMPORARY,
            is_active=True,
        )
        self.assertEqual(
            _event_registration_temporary_member(email="temporary@example.com", event_code=""),
            (True, None),
        )
        member.is_active = False
        member.save(update_fields=["is_active"])
        self.assertEqual(
            _event_registration_temporary_member(
                email="temporary@example.com", event_code="event-code"
            ),
            (True, None),
        )

    def test_login_code_request_for_unknown_email_keeps_generic_response(self):
        from apps.authn.serializers.email_code.auth import LoginCodeRequestSerializer

        serializer = LoginCodeRequestSerializer()
        serializer._validated_data = {"email": "unknown@example.com"}
        with (
            patch("apps.authn.serializers.email_code.auth.resolve_auth_email", return_value=None),
            patch("apps.authn.serializers.email_code.auth.issue_email_challenge") as issue,
        ):
            result = serializer.save()
        issue.assert_not_called()
        self.assertIn("eligible account", result["message"])

    def test_unified_verify_without_callback_sets_challenge_and_flow(self):
        from apps.authn.serializers.email_code.auth import UnifiedEmailAuthVerifySerializer

        challenge = SimpleNamespace(purpose=EmailAuthChallenge.Purpose.REGISTER)
        serializer = UnifiedEmailAuthVerifySerializer()
        serializer.context.clear()
        with patch(
            "apps.authn.serializers.email_code.auth.verify_email_code_for_purposes",
            return_value=challenge,
        ):
            result = serializer.validate({"email": "user@example.com", "code": "123456"})
        self.assertIs(result["challenge"], challenge)
        self.assertEqual(result["flow"], "register")

    def test_base_code_verify_without_callback_sets_member(self):
        from apps.authn.serializers.email_code.base import BaseCodeVerifySerializer

        member = _member()
        challenge = SimpleNamespace(member=member)
        serializer = BaseCodeVerifySerializer()
        serializer.purpose = EmailAuthChallenge.Purpose.LOGIN
        with patch(
            "apps.authn.serializers.email_code.base.verify_email_code",
            return_value=challenge,
        ):
            result = serializer.validate({"email": "user@example.com", "code": "123456"})
        self.assertIs(result["challenge"], challenge)
        self.assertIs(result["member"], member)

    def test_password_reset_verify_handles_unknown_identity_and_invalid_code(self):
        from apps.authn.serializers.email_code.passwords import PasswordResetVerifySerializer

        serializer = PasswordResetVerifySerializer()
        with patch(
            "apps.authn.serializers.email_code.passwords.resolve_login_identifier",
            return_value=None,
        ):
            with self.assertRaises(serializers.ValidationError):
                serializer.validate({"identifier": "unknown", "code": "123456"})

        member = _member()
        resolved = SimpleNamespace(email="user@example.com", member=member)
        with (
            patch(
                "apps.authn.serializers.email_code.passwords.resolve_login_identifier",
                return_value=resolved,
            ),
            patch(
                "apps.authn.serializers.email_code.passwords.verify_email_code_and_mint_token",
                side_effect=__import__(
                    "apps.authn.services.email.challenges",
                    fromlist=["AuthChallengeInvalid"],
                ).AuthChallengeInvalid("bad"),
            ),
        ):
            with self.assertRaises(serializers.ValidationError):
                serializer.validate({"identifier": "user@example.com", "code": "123456"})

    def test_delete_account_verify_rejects_challenge_for_another_member(self):
        from apps.authn.serializers.email_code.passwords import DeleteAccountCodeVerifySerializer

        member = _member(email="member@example.com", is_active=True)
        other = _member()
        serializer = DeleteAccountCodeVerifySerializer(
            context={"request": SimpleNamespace(user=member)}
        )
        with patch(
            "apps.authn.serializers.email_code.passwords.verify_email_code_and_mint_token",
            return_value=(SimpleNamespace(member=other), "token"),
        ):
            with self.assertRaises(serializers.ValidationError):
                serializer.validate({"code": "123456"})


class RecoveryAndAuthEmailBranchTests(TestCase):
    def test_mask_email_without_at_and_fallback_to_any_verified_email(self):
        from apps.authn.services.account.channel_select import mask_email, select_recovery_channel

        self.assertEqual(mask_email("local-only"), "local-only")
        member = _member()
        ContactEmail.objects.create(
            member=member,
            email_address="other@example.com",
            email_type="other",
            verified=True,
        )
        selected = select_recovery_channel(member)
        self.assertEqual(selected.target_email, "other@example.com")

    def test_recovery_count_with_and_without_exclusion(self):
        from apps.authn.services.account.recovery import count_verified_recovery_contacts

        member = _member(email="primary@example.com")
        contact = member.contact_emails.get()
        self.assertEqual(count_verified_recovery_contacts(member), 1)
        self.assertEqual(count_verified_recovery_contacts(member, exclude_email_pk=contact.pk), 0)

    @override_settings(FRONTEND_URL="", BACKEND_URL="https://backend.example.com/")
    def test_frontend_url_falls_back_to_backend(self):
        from apps.authn.services.account.unsubscribe import build_frontend_absolute_url

        self.assertEqual(
            build_frontend_absolute_url("/account"), "https://backend.example.com/account"
        )

    def test_auth_email_non_email_identifier_and_deduplicated_contacts(self):
        from apps.authn.services.email.auth_email import (
            get_member_auth_emails,
            resolve_login_identifier,
        )

        self.assertIsNone(resolve_login_identifier(""))
        self.assertIsNone(resolve_login_identifier("member-id"))
        member = _member()
        contacts = [
            SimpleNamespace(email_address="DUP@example.com"),
            SimpleNamespace(email_address="dup@example.com "),
        ]
        with patch(
            "apps.authn.services.email.auth_email.ContactEmail.objects.filter"
        ) as filter_contacts:
            filter_contacts.return_value.order_by.return_value = contacts
            self.assertEqual(get_member_auth_emails(member), ["dup@example.com"])


class ContactEmailServiceBranchTests(TestCase):
    @override_settings(BACKGROUND_JOBS_ENABLED=True)
    def test_notification_queue_failure_is_best_effort(self):
        from apps.authn.services.contacts.contact_emails import (
            _notify_email_owner_in_background,
        )

        with patch(
            "apps.core.services.background_jobs.enqueue_notification_email",
            side_effect=RuntimeError("queue down"),
        ):
            _notify_email_owner_in_background("owner@example.com")

    def test_verify_callback_handles_deleted_and_already_verified_contact(self):
        from apps.authn.services.contacts.contact_emails import verify_contact_email_code
        from apps.authn.services.email.challenges import AuthChallengeInvalid

        member = _member()
        contact = ContactEmail.objects.create(
            member=member,
            email_address="verify@example.com",
            email_type="primary",
            verified=False,
        )

        def delete_before_approval(**kwargs):
            contact.delete()
            return kwargs["approved_callback"](object())

        with patch(
            "apps.authn.services.contacts.contact_emails.verify_email_code",
            side_effect=delete_before_approval,
        ):
            with self.assertRaises(AuthChallengeInvalid):
                verify_contact_email_code(member=member, contact_email_id=contact.pk, code="123456")

        verified = ContactEmail.objects.create(
            member=member,
            email_address="verified@example.com",
            email_type="primary",
            verified=True,
        )

        def approve(**kwargs):
            return kwargs["approved_callback"](object())

        with patch(
            "apps.authn.services.contacts.contact_emails.verify_email_code",
            side_effect=approve,
        ):
            result = verify_contact_email_code(
                member=member, contact_email_id=verified.pk, code="123456"
            )
        self.assertTrue(result.verified)

    def test_delete_primary_with_no_remaining_email_needs_no_replacement(self):
        from apps.authn.services.contacts.contact_emails import delete_contact_email

        member = _member(email="only@example.com", verified=False)
        contact = member.contact_emails.get()
        delete_contact_email(member=member, contact_email_id=contact.pk)
        self.assertFalse(member.contact_emails.exists())

    def test_make_primary_without_old_primary_promotes_target(self):
        from apps.authn.services.contacts.contact_emails import make_contact_email_primary

        member = _member()
        target = ContactEmail.objects.create(
            member=member,
            email_address="target@example.com",
            email_type="other",
            verified=True,
        )
        result = make_contact_email_primary(member=member, contact_email_id=target.pk)
        self.assertEqual(result.email_type, "primary")


class ChallengeBranchTests(TestCase):
    def setUp(self):
        self.member = _member()

    def test_compatibility_verify_wrapper_delegates(self):
        from apps.authn.services.email import challenges

        with patch.object(challenges, "verify_email_code", return_value="verified") as verify:
            self.assertEqual(
                challenges.verify_email_challenge(
                    email="user@example.com",
                    code="123456",
                    purpose=EmailAuthChallenge.Purpose.LOGIN,
                    consume=False,
                    scope_key="legacy",
                ),
                "verified",
            )
        verify.assert_called_once()

    def test_restore_keeps_old_codes_expired_when_new_replacement_exists(self):
        from apps.authn.services.email.challenges.issue import (
            _restore_superseded_challenges,
        )

        previous = _challenge(
            self.member,
            status=EmailAuthChallenge.Status.EXPIRED,
            target_email="user@example.com",
        )
        failed = _challenge(self.member, target_email="user@example.com")
        replacement = _challenge(self.member, target_email="user@example.com")
        _restore_superseded_challenges(
            challenge=failed,
            superseded_states=[(previous.pk, EmailAuthChallenge.Status.PENDING)],
        )
        previous.refresh_from_db()
        self.assertEqual(previous.status, EmailAuthChallenge.Status.EXPIRED)
        self.assertTrue(EmailAuthChallenge.objects.filter(pk=replacement.pk).exists())

    def test_pending_query_without_row_lock(self):
        from apps.authn.services.email.challenges.queries import (
            get_latest_pending_for_purposes,
        )

        challenge = _challenge(self.member)
        self.assertEqual(
            get_latest_pending_for_purposes(
                purposes=[challenge.purpose],
                target_email=challenge.target_email,
                for_update=False,
            ),
            challenge,
        )

    def test_unsupported_transition_and_lost_transition_are_rejected(self):
        from apps.authn.services.email.challenges.verify import (
            _verify_and_transition_email_code,
        )

        challenge = _challenge(self.member)
        with self.assertRaisesMessage(ValueError, "Unsupported"):
            _verify_and_transition_email_code(
                purposes=[challenge.purpose],
                target_email=challenge.target_email,
                code="123456",
                target_status="unsupported",
            )

        challenge.delete()
        challenge = _challenge(self.member)
        update_queryset = MagicMock()
        update_queryset.update.return_value = 0
        with (
            patch(
                "apps.authn.services.email.challenges.verify.latest_pending_for_input",
                return_value=challenge,
            ),
            patch.object(EmailAuthChallenge.objects, "filter", return_value=update_queryset),
        ):
            result = _verify_and_transition_email_code(
                purposes=[challenge.purpose],
                target_email=challenge.target_email,
                code="123456",
                target_status=EmailAuthChallenge.Status.CONSUMED,
            )
        self.assertIsNone(result[0])

    def test_mark_verified_lost_update_is_rejected(self):
        from apps.authn.services.email.challenges import AuthChallengeInvalid
        from apps.authn.services.email.challenges.verify import mark_challenge_verified

        challenge = _challenge(self.member)
        locked_queryset = MagicMock()
        locked_queryset.filter.return_value.first.return_value = challenge
        update_queryset = MagicMock()
        update_queryset.update.return_value = 0
        with (
            patch.object(
                EmailAuthChallenge.objects,
                "select_for_update",
                return_value=locked_queryset,
            ),
            patch.object(EmailAuthChallenge.objects, "filter", return_value=update_queryset),
        ):
            with self.assertRaises(AuthChallengeInvalid):
                mark_challenge_verified(challenge)

    def test_consume_login_challenge_rejects_non_pending_row(self):
        from apps.authn.services.email.challenges import (
            AuthChallengeInvalid,
            consume_login_or_registration_challenge,
        )

        challenge = _challenge(self.member, status=EmailAuthChallenge.Status.CONSUMED)
        with self.assertRaises(AuthChallengeInvalid):
            consume_login_or_registration_challenge(challenge)

        pending = _challenge(
            self.member,
            target_email="second@example.com",
            status=EmailAuthChallenge.Status.PENDING,
        )
        consume_login_or_registration_challenge(pending)
        self.assertEqual(pending.status, EmailAuthChallenge.Status.CONSUMED)

    def test_consume_token_without_member_handles_empty_hash_and_lost_update(self):
        from apps.authn.services.email.challenges.verify import (
            _consume_verification_token,
        )

        _challenge(
            self.member,
            status=EmailAuthChallenge.Status.VERIFIED,
            verification_token_hash="",
            verified_at=timezone.now() - timedelta(seconds=1),
        )
        matching = _challenge(
            self.member,
            status=EmailAuthChallenge.Status.VERIFIED,
            verification_token_hash=make_password("token"),
            verified_at=timezone.now(),
        )
        update_queryset = MagicMock()
        update_queryset.update.return_value = 0
        with patch.object(EmailAuthChallenge.objects, "filter", return_value=update_queryset):
            result = _consume_verification_token(
                purpose=matching.purpose,
                verification_token="token",
                member=None,
            )
        self.assertIsNone(result)


class EmailSenderBranchTests(SimpleTestCase):
    def test_notification_sender_forwards_optional_provider_hooks(self):
        from apps.authn.services.email.send_email import senders

        callback = MagicMock()
        with (
            patch.object(senders, "render_to_string", return_value="<p>body</p>"),
            patch("apps.authn.services.email.send_email._send_via_ses", return_value=True) as send,
        ):
            self.assertTrue(
                senders.send_notification_email(
                    recipient="user@example.com",
                    subject="Subject",
                    template="template.html",
                    context={},
                    before_provider_call=callback,
                    raise_provider_errors=True,
                )
            )
        self.assertIs(send.call_args.kwargs["before_provider_call"], callback)
        self.assertTrue(send.call_args.kwargs["raise_provider_errors"])

    def test_invitation_without_inviter_uses_team_name(self):
        from apps.authn.services.email.send_email import senders

        invitation = SimpleNamespace(
            invited_by=None,
            expires_at=timezone.now() + timedelta(days=1),
            message="",
            email="invitee@example.com",
            get_role_display=lambda: "Admin",
            get_acceptance_url=lambda request: "https://example.com/accept",
        )
        with (
            patch.object(senders, "render_branded_email", return_value="body") as render,
            patch("apps.authn.services.email.send_email._send_via_ses", return_value=True),
        ):
            senders.send_admin_invitation_email(invitation=invitation)
        self.assertIn("The Releviz team", render.call_args.kwargs["preheader"])

    def test_invitation_with_unnamed_inviter_falls_back_to_string(self):
        from apps.authn.services.email.send_email import senders

        class Inviter:
            def get_full_name(self):
                return ""

            def __str__(self):
                return "fallback inviter"

        invitation = SimpleNamespace(
            invited_by=Inviter(),
            expires_at=timezone.now() + timedelta(days=1),
            message="Message",
            email="invitee@example.com",
            get_role_display=lambda: "Admin",
            get_acceptance_url=lambda request: "https://example.com/accept",
        )
        with (
            patch.object(senders, "render_branded_email", return_value="body") as render,
            patch("apps.authn.services.email.send_email._send_via_ses", return_value=True),
        ):
            senders.send_admin_invitation_email(invitation=invitation)
        self.assertIn("fallback inviter", render.call_args.kwargs["preheader"])

    def test_transport_runs_before_provider_callback(self):
        from apps.authn.services.email.send_email import transport

        callback = MagicMock()
        client = MagicMock()
        credentials = SimpleNamespace(
            region="us-east-1", access_key_id="key", secret_access_key="secret"
        )
        with (
            patch.object(transport, "resolve_aws_credentials", return_value=credentials),
            patch("apps.authn.services.email.send_email.boto3.client", return_value=client),
        ):
            self.assertTrue(
                transport._send_via_ses(
                    recipient="user@example.com",
                    subject="Subject",
                    html_body="body",
                    source_address="from@example.com",
                    before_provider_call=callback,
                )
            )
        callback.assert_called_once_with()


class RegistrationServiceBranchTests(TestCase):
    def _data(self, **overrides):
        data = {
            "email": "new@example.com",
            "password": "StrongPass123!",
            "password_confirm": "StrongPass123!",
            "first_name": "First",
            "last_name": "Last",
        }
        data.update(overrides)
        return data

    def test_password_pair_validation_and_name_validation(self):
        from apps.authn.services.members import register

        with patch.object(register, "decrypt_password", side_effect=lambda value, _key: value):
            self.assertEqual(
                register.validate_password_pair({"password": "StrongPass123!", "key_id": ""}),
                "StrongPass123!",
            )
            with self.assertRaises(serializers.ValidationError):
                register.validate_password_pair(
                    {
                        "password": "StrongPass123!",
                        "password_confirm": "DifferentPass123!",
                        "key_id": "",
                    }
                )
            with self.assertRaises(serializers.ValidationError):
                register.validate_password_pair(
                    {"password": "short", "password_confirm": "short", "key_id": ""}
                )
            with self.assertRaises(serializers.ValidationError):
                register._validated_registration_details(self._data(first_name="", firstName=""))
            with self.assertRaises(serializers.ValidationError):
                register._validated_registration_details(self._data(last_name="", lastName=""))
            details = register._validated_registration_details(
                self._data(first_name="", firstName="Camel", last_name="", lastName="Case")
            )
        self.assertEqual(details["first_name"], "Camel")
        self.assertEqual(details["last_name"], "Case")

    def test_start_registration_requires_email_and_creates_new_member(self):
        from apps.authn.services.members import register

        with patch.object(register, "decrypt_password", side_effect=lambda value, _key: value):
            with self.assertRaises(serializers.ValidationError):
                register.start_registration(self._data(email=""))
            with patch.object(register, "issue_email_challenge") as issue:
                member = register.start_registration(self._data())
        self.assertFalse(member.is_active)
        self.assertEqual(member.first_name, "First")
        self.assertTrue(ContactEmail.objects.filter(member=member, email_type="primary").exists())
        issue.assert_called_once()

    def test_start_registration_rejects_common_password_without_writing_member(self):
        from apps.authn.services.members import register

        with (
            patch.object(register, "decrypt_password", side_effect=lambda value, _key: value),
            self.assertRaises(serializers.ValidationError) as raised,
        ):
            register.start_registration(
                self._data(password="password", password_confirm="password")
            )

        self.assertIn("password", raised.exception.detail)
        self.assertFalse(Member.objects.filter(email="new@example.com").exists())
        self.assertFalse(ContactEmail.objects.filter(email_address="new@example.com").exists())

    def test_start_registration_updates_existing_unverified_member(self):
        from apps.authn.services.members import register

        member = _member(
            email="existing@example.com",
            verified=False,
            first_name="Old",
            is_active=True,
        )
        with (
            patch.object(register, "decrypt_password", side_effect=lambda value, _key: value),
            patch.object(register, "issue_email_challenge"),
        ):
            result = register.start_registration(self._data(email="existing@example.com"))
        self.assertEqual(result.pk, member.pk)
        self.assertFalse(result.is_active)
        self.assertEqual(result.first_name, "First")

    def test_temporary_upgrade_rejects_invalid_and_mismatched_ids_then_accepts_match(self):
        from apps.authn.services.members import register

        member = _member(
            email="temp@example.com",
            verified=False,
            is_active=True,
            access_level="temporary",
        )
        with patch.object(register, "decrypt_password", side_effect=lambda value, _key: value):
            with self.assertRaises(serializers.ValidationError):
                register.start_registration(
                    self._data(email="temp@example.com"),
                    _temporary_upgrade_member_id="not-a-uuid",
                )
            with self.assertRaises(serializers.ValidationError):
                register.start_registration(
                    self._data(email="missing@example.com"),
                    _temporary_upgrade_member_id=member.pk,
                )
            with self.assertRaises(serializers.ValidationError):
                register.start_registration(
                    self._data(email="temp@example.com"),
                    _temporary_upgrade_member_id=__import__("uuid").uuid4(),
                )
            with patch.object(register, "issue_email_challenge") as issue:
                result = register.start_registration(
                    self._data(email="temp@example.com"),
                    _temporary_upgrade_member_id=member.pk,
                )
        self.assertEqual(result.pk, member.pk)
        self.assertTrue(result.is_active)
        self.assertEqual(
            issue.call_args.kwargs["scope_key"], register.TEMP_SESSION_REGISTRATION_SCOPE
        )

        full_member = _member(
            email="not-temporary@example.com",
            verified=False,
            is_active=True,
        )
        with patch.object(register, "decrypt_password", side_effect=lambda value, _key: value):
            with self.assertRaises(serializers.ValidationError):
                register.start_registration(
                    self._data(email="not-temporary@example.com"),
                    _temporary_upgrade_member_id=full_member.pk,
                )

    def test_verified_contact_and_delivery_failure_are_propagated(self):
        from apps.authn.services.email.challenges import AuthChallengeDeliveryError
        from apps.authn.services.members import register

        _member(email="taken@example.com", verified=True)
        with patch.object(register, "decrypt_password", side_effect=lambda value, _key: value):
            with self.assertRaises(serializers.ValidationError):
                register.start_registration(self._data(email="taken@example.com"))
            with (
                patch.object(
                    register,
                    "issue_email_challenge",
                    side_effect=AuthChallengeDeliveryError("down"),
                ),
                self.assertRaises(AuthChallengeDeliveryError),
            ):
                register.start_registration(self._data(email="delivery@example.com"))


class RsaManagerBranchTests(TestCase):
    def test_concurrent_key_creation_fetches_winner(self):
        from apps.authn.services.security import rsa_manager

        winner = SimpleNamespace(name=rsa_manager.AUTH_KEY_NAME, is_active=True)
        query = MagicMock()
        query.filter.return_value.first.return_value = None
        query.get.return_value = winner
        with (
            patch.object(rsa_manager, "purge_retired_auth_keypairs"),
            patch.object(RSAKeypair.objects, "select_for_update", return_value=query),
            patch.object(
                RSAKeypair.objects,
                "create",
                side_effect=__import__("django.db", fromlist=["IntegrityError"]).IntegrityError,
            ),
        ):
            self.assertIs(rsa_manager.get_or_create_auth_keypair(), winner)


class ExportAndImportBranchTests(TestCase):
    def test_empty_vcard_export_and_claimed_contact_append_paths(self):
        from apps.authn.services.members.export_vcf import export_members_to_vcard
        from apps.authn.services.members.import_.excel import _append_contact_records

        self.assertEqual(export_members_to_vcard(Member.objects.none()), b"")
        member = _member()
        parsed = {
            "primary_email": "primary@example.com",
            "primary_verified": True,
            "primary_subscribed": True,
            "secondary_email": "secondary@example.com",
            "secondary_verified": False,
            "secondary_subscribed": False,
        }
        pending = []
        claimed = {"primary@example.com", "secondary@example.com"}
        _append_contact_records(member, parsed, pending, claimed)
        self.assertEqual(pending, [])

    def test_bulk_update_skips_claimed_secondary(self):
        from apps.authn.services.members.import_.operations import update_single_member

        member = _member(email="primary@example.com")
        parsed = {
            "primary_email": "primary@example.com",
            "primary_verified": True,
            "primary_subscribed": True,
            "secondary_email": "claimed@example.com",
            "secondary_verified": False,
            "secondary_subscribed": False,
            "first_name": "Updated",
            "middle_name": "",
            "last_name": "Member",
            "organization": "",
            "title": "",
            "access_level": member.access_level,
            "is_active": member.is_active,
            "is_staff": member.is_staff,
        }
        result = update_single_member(
            member, parsed, {"primary@example.com", "claimed@example.com"}
        )
        self.assertEqual(result.pk, member.pk)
        self.assertFalse(member.contact_emails.filter(email_address="claimed@example.com").exists())
