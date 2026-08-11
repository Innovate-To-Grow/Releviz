"""Coverage tests for assorted authn service helpers."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError
from django.test import TestCase, override_settings

from apps.authn.models import ContactEmail
from apps.authn.services.account.unsubscribe import (
    UnsubscribeLoginTokenAlreadyUsed,
    UnsubscribeLoginTokenInvalid,
    build_unsubscribe_login_token,
    get_member_from_unsubscribe_token,
)
from apps.authn.services.contacts.contact_emails import (
    _member_has_secondary,
    create_contact_email,
    delete_contact_email,
    make_contact_email_primary,
    resend_contact_email_verification,
    verify_contact_email_code,
)
from apps.authn.services.email.auth_email import (
    claim_unclaimed_contact_email,
    get_pending_registration_member,
    get_unclaimed_contact_email,
    resolve_auth_email,
)
from apps.authn.services.email.challenges import AuthChallengeInvalid
from apps.authn.services.members.create import CreateMemberService
from apps.authn.services.security.key_encryption import decrypt_pem, encrypt_pem, is_encrypted

Member = get_user_model()


def _member(email="primary@example.com", **kwargs):
    member = Member.objects.create_user(
        password="StrongPass123!",
        first_name=kwargs.pop("first_name", "First"),
        last_name=kwargs.pop("last_name", "Last"),
        is_active=kwargs.pop("is_active", True),
        **kwargs,
    )
    ContactEmail.objects.create(member=member, email_address=email, email_type="primary", verified=True)
    return member


class CreateMemberErrorPathTests(TestCase):
    def test_integrity_error_path(self):
        with patch(
            "apps.authn.services.members.create.Member.objects.create_user",
            side_effect=IntegrityError("dup key"),
        ):
            result = CreateMemberService.create_member(password="StrongPass123!", first_name="A", last_name="B")
        self.assertFalse(result["success"])
        self.assertIn("Database integrity error", result["error"])

    def test_validation_error_path(self):
        with patch(
            "apps.authn.services.members.create.Member.objects.create_user",
            side_effect=ValidationError("bad"),
        ):
            result = CreateMemberService.create_member(password="StrongPass123!", first_name="A", last_name="B")
        self.assertFalse(result["success"])
        self.assertIn("Validation error", result["error"])

    def test_unexpected_error_path(self):
        with patch(
            "apps.authn.services.members.create.Member.objects.create_user",
            side_effect=RuntimeError("boom"),
        ):
            result = CreateMemberService.create_member(password="StrongPass123!", first_name="A", last_name="B")
        self.assertFalse(result["success"])
        self.assertIn("Unexpected error", result["error"])


class AuthEmailHelperTests(TestCase):
    def test_resolve_auth_email_empty_returns_none(self):
        self.assertIsNone(resolve_auth_email(""))

    def test_get_unclaimed_contact_email_empty_returns_none(self):
        self.assertIsNone(get_unclaimed_contact_email(""))

    def test_get_unclaimed_contact_email_returns_match(self):
        ContactEmail.objects.create(email_address="unclaimed@example.com", email_type="primary", member=None)
        result = get_unclaimed_contact_email("Unclaimed@Example.com")
        self.assertIsNotNone(result)

    def test_claim_unclaimed_contact_email_empty_returns_none(self):
        member = _member()
        self.assertIsNone(claim_unclaimed_contact_email("", member=member))

    def test_claim_unclaimed_contact_email_no_match_returns_none(self):
        member = _member()
        self.assertIsNone(claim_unclaimed_contact_email("nothing@example.com", member=member))

    def test_get_pending_registration_member_empty_returns_none(self):
        self.assertIsNone(get_pending_registration_member(""))


class ContactEmailServiceTests(TestCase):
    def setUp(self):
        self.member = _member()

    def test_member_has_secondary_with_exclude(self):
        sec = ContactEmail.objects.create(member=self.member, email_address="sec@example.com", email_type="secondary")
        self.assertTrue(_member_has_secondary(self.member))
        self.assertFalse(_member_has_secondary(self.member, exclude_pk=sec.pk))

    def test_create_contact_email_rejects_second_secondary(self):
        ContactEmail.objects.create(member=self.member, email_address="sec1@example.com", email_type="secondary")
        with self.assertRaises(AuthChallengeInvalid):
            create_contact_email(member=self.member, email_address="sec2@example.com")

    @patch("apps.authn.services.contacts.contact_emails._notify_email_owner_in_background")
    def test_create_contact_email_conflict_notifies_owner(self, mock_notify):
        other = _member(email="taken@example.com", first_name="O", last_name="Wner")
        with self.assertRaises(AuthChallengeInvalid):
            create_contact_email(member=self.member, email_address="taken@example.com")
        mock_notify.assert_called_once()

    @patch("apps.authn.services.contacts.contact_emails.issue_email_challenge")
    @patch("apps.authn.services.contacts.contact_emails._notify_email_owner_in_background")
    def test_create_contact_email_integrity_error_notifies(self, mock_notify, mock_issue):
        with patch(
            "apps.authn.services.contacts.contact_emails.ContactEmail.objects.create",
            side_effect=IntegrityError("dup"),
        ):
            with self.assertRaises(AuthChallengeInvalid):
                create_contact_email(member=self.member, email_address="brandnew@example.com")
        mock_notify.assert_called_once()

    def test_verify_contact_email_code_not_found(self):
        import uuid

        with self.assertRaises(AuthChallengeInvalid):
            verify_contact_email_code(member=self.member, contact_email_id=uuid.uuid4(), code="123456")

    @patch("apps.authn.services.contacts.contact_emails.verify_email_code")
    def test_verify_contact_email_code_marks_contact_inside_approved_callback(self, mock_verify):
        contact = ContactEmail.objects.create(
            member=self.member,
            email_address="verify-me@example.com",
            email_type="secondary",
            verified=False,
        )

        def approve(**kwargs):
            return kwargs["approved_callback"](object())

        mock_verify.side_effect = approve
        result = verify_contact_email_code(member=self.member, contact_email_id=contact.pk, code="123456")

        self.assertEqual(result.pk, contact.pk)
        self.assertTrue(result.verified)
        self.assertTrue(callable(mock_verify.call_args.kwargs["approved_callback"]))

    def test_resend_verification_not_found(self):
        import uuid

        with self.assertRaises(AuthChallengeInvalid):
            resend_contact_email_verification(member=self.member, contact_email_id=uuid.uuid4())

    def test_resend_verification_already_verified(self):
        verified = ContactEmail.objects.create(
            member=self.member, email_address="ver@example.com", email_type="secondary", verified=True
        )
        with self.assertRaises(AuthChallengeInvalid):
            resend_contact_email_verification(member=self.member, contact_email_id=verified.pk)

    def test_delete_contact_email_not_found(self):
        import uuid

        with self.assertRaises(AuthChallengeInvalid):
            delete_contact_email(member=self.member, contact_email_id=uuid.uuid4())

    def test_make_primary_not_found(self):
        import uuid

        with self.assertRaises(AuthChallengeInvalid):
            make_contact_email_primary(member=self.member, contact_email_id=uuid.uuid4())

    @override_settings(FRONTEND_URL="https://example.com", BACKGROUND_JOBS_ENABLED=False)
    @patch(
        "apps.authn.services.contacts.contact_emails.start_in_process_task",
        side_effect=lambda target, *args, **_kwargs: target(*args),
    )
    @patch("apps.authn.services.email.send_email.send_notification_email")
    def test_notify_email_owner_logs_on_failure(self, mock_send, start_task):
        from apps.authn.services.contacts import contact_emails as svc

        mock_send.side_effect = RuntimeError("smtp down")
        svc._notify_email_owner_in_background("owner@example.com")
        mock_send.assert_called_once()
        start_task.assert_called_once()
        self.assertTrue(start_task.call_args.kwargs["best_effort_start"])

    @override_settings(FRONTEND_URL="https://example.com", BACKGROUND_JOBS_ENABLED=True)
    @patch("apps.core.services.background_jobs.enqueue_notification_email")
    def test_notify_email_owner_uses_durable_queue_when_enabled(self, mock_enqueue):
        from apps.authn.services.contacts import contact_emails as svc

        svc._notify_email_owner_in_background("owner@example.com")

        mock_enqueue.assert_called_once_with(
            recipient="owner@example.com",
            subject="Security notice - Innovate to Grow",
            template="authn/email/email_claim_notification.html",
            context={"account_url": "https://example.com/account"},
        )


class KeyEncryptionTests(TestCase):
    def test_round_trip(self):
        encrypted = encrypt_pem("PEM-DATA")
        self.assertTrue(is_encrypted(encrypted))
        self.assertEqual(decrypt_pem(encrypted), "PEM-DATA")

    def test_legacy_plaintext_passthrough(self):
        self.assertEqual(decrypt_pem("plain-pem"), "plain-pem")
        self.assertFalse(is_encrypted("plain-pem"))

    @override_settings(SECRET_KEY="a-different-secret-key-entirely")
    def test_decrypt_with_wrong_key_raises(self):
        # Encrypt with current key, then change the key so decryption fails.
        with override_settings(SECRET_KEY="original-secret"):
            encrypted = encrypt_pem("PEM-DATA")
        with self.assertRaisesMessage(ValueError, "Failed to decrypt private key"):
            decrypt_pem(encrypted)


class UnsubscribeTokenTests(TestCase):
    def setUp(self):
        from django.core.cache import cache

        cache.clear()
        self.member = _member()

    def test_round_trip_returns_member(self):
        token = build_unsubscribe_login_token(self.member)
        resolved = get_member_from_unsubscribe_token(token)
        self.assertEqual(resolved.pk, self.member.pk)

    def test_invalid_token_raises(self):
        with self.assertRaises(UnsubscribeLoginTokenInvalid):
            get_member_from_unsubscribe_token("garbage.token.value")

    def test_inactive_or_missing_member_raises(self):
        token = build_unsubscribe_login_token(self.member)
        self.member.is_active = False
        self.member.save(update_fields=["is_active"])
        with self.assertRaises(UnsubscribeLoginTokenInvalid):
            get_member_from_unsubscribe_token(token)

    def test_token_replay_raises_already_used(self):
        token = build_unsubscribe_login_token(self.member)
        get_member_from_unsubscribe_token(token)
        with self.assertRaises(UnsubscribeLoginTokenAlreadyUsed):
            get_member_from_unsubscribe_token(token)
