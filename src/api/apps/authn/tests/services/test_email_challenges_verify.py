"""Tests for email.challenges verify/queries internals and the challenge model."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.db import close_old_connections, connection, connections
from django.test import TestCase, TransactionTestCase
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.authn.models.security import EmailAuthChallenge
from apps.authn.services.email.challenges import (
    AuthChallengeInvalid,
    consume_verification_token,
    mark_challenge_verified,
    verify_email_code,
    verify_email_code_and_mint_token,
)
from apps.authn.services.email.challenges.queries import assert_within_limit, get_latest_pending

Member = get_user_model()
PURPOSE = EmailAuthChallenge.Purpose.LOGIN


def _make_member():
    member = Member.objects.create_user(password="StrongPass123!", is_active=True)
    ContactEmail.objects.create(
        member=member, email_address="user@example.com", email_type="primary", verified=True
    )
    return member


def _make_challenge(member, code="123456", **overrides):
    defaults = {
        "member": member,
        "purpose": PURPOSE,
        "target_email": "user@example.com",
        "code_hash": make_password(code),
        "expires_at": timezone.now() + timedelta(minutes=10),
        "max_attempts": 5,
        "last_sent_at": timezone.now(),
        "status": EmailAuthChallenge.Status.PENDING,
    }
    defaults.update(overrides)
    return EmailAuthChallenge.objects.create(**defaults)


class VerifyEmailCodeTests(TestCase):
    def setUp(self):
        self.member = _make_member()

    def test_no_challenge_raises(self):
        with self.assertRaises(AuthChallengeInvalid):
            verify_email_code(purpose=PURPOSE, target_email="user@example.com", code="123456")

    def test_expired_challenge_marked_and_raises(self):
        challenge = _make_challenge(self.member, expires_at=timezone.now() - timedelta(minutes=1))
        with self.assertRaisesMessage(AuthChallengeInvalid, "invalid or has expired"):
            verify_email_code(purpose=PURPOSE, target_email="user@example.com", code="123456")
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.EXPIRED)

    def test_wrong_code_raises_invalid(self):
        challenge = _make_challenge(self.member)
        with self.assertRaisesMessage(AuthChallengeInvalid, "invalid or has expired"):
            verify_email_code(purpose=PURPOSE, target_email="user@example.com", code="000000")
        challenge.refresh_from_db()
        self.assertEqual(challenge.attempts, 1)

    def test_wrong_code_on_last_attempt_raises(self):
        challenge = _make_challenge(self.member, attempts=4)
        with self.assertRaisesMessage(AuthChallengeInvalid, "invalid or has expired"):
            verify_email_code(purpose=PURPOSE, target_email="user@example.com", code="000000")
        challenge.refresh_from_db()
        self.assertEqual(challenge.attempts, 5)
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.EXPIRED)

    def test_correct_code_consumes_challenge(self):
        _make_challenge(self.member)
        result = verify_email_code(purpose=PURPOSE, target_email="user@example.com", code="123456")
        self.assertEqual(result.status, EmailAuthChallenge.Status.CONSUMED)
        with self.assertRaises(AuthChallengeInvalid):
            verify_email_code(purpose=PURPOSE, target_email="user@example.com", code="123456")

    def test_correct_code_returns_approved_callback_result(self):
        challenge = _make_challenge(self.member)

        result = verify_email_code(
            purpose=PURPOSE,
            target_email="user@example.com",
            code="123456",
            approved_callback=lambda approved: f"approved:{approved.pk}",
        )

        self.assertEqual(result, f"approved:{challenge.pk}")
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.CONSUMED)

    def test_approved_callback_failure_rolls_back_code_and_member_write(self):
        challenge = _make_challenge(self.member)
        original_first_name = self.member.first_name

        def fail_after_member_write(_approved):
            Member.objects.filter(pk=self.member.pk).update(first_name="Not committed")
            raise RuntimeError("JWT creation failed")

        with self.assertRaisesMessage(RuntimeError, "JWT creation failed"):
            verify_email_code(
                purpose=PURPOSE,
                target_email="user@example.com",
                code="123456",
                approved_callback=fail_after_member_write,
            )

        challenge.refresh_from_db()
        self.member.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.PENDING)
        self.assertEqual(self.member.first_name, original_first_name)

    def test_correct_code_and_token_creation_are_one_transition(self):
        challenge = _make_challenge(self.member)
        verified, token = verify_email_code_and_mint_token(
            purpose=PURPOSE,
            target_email="user@example.com",
            code="123456",
            member=self.member,
        )
        self.assertEqual(verified.status, EmailAuthChallenge.Status.VERIFIED)
        self.assertTrue(token)
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.VERIFIED)
        with self.assertRaises(AuthChallengeInvalid):
            verify_email_code_and_mint_token(
                purpose=PURPOSE,
                target_email="user@example.com",
                code="123456",
                member=self.member,
            )


class ConsumeVerificationTokenTests(TestCase):
    def setUp(self):
        self.member = _make_member()

    def test_valid_token_consumes_challenge(self):
        challenge = _make_challenge(self.member)
        token = mark_challenge_verified(challenge)
        consumed = consume_verification_token(
            purpose=PURPOSE, verification_token=token, member=self.member
        )
        self.assertEqual(consumed.status, EmailAuthChallenge.Status.CONSUMED)
        with self.assertRaises(AuthChallengeInvalid):
            consume_verification_token(
                purpose=PURPOSE, verification_token=token, member=self.member
            )

    def test_expired_verified_challenge_skipped(self):
        challenge = _make_challenge(self.member, status=EmailAuthChallenge.Status.VERIFIED)
        challenge.verification_token_hash = make_password("tok")
        challenge.expires_at = timezone.now() - timedelta(seconds=1)
        challenge.verified_at = timezone.now()
        challenge.save(update_fields=["verification_token_hash", "expires_at", "verified_at"])
        with self.assertRaises(AuthChallengeInvalid):
            consume_verification_token(
                purpose=PURPOSE, verification_token="tok", member=self.member
            )
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.EXPIRED)

    def test_invalid_token_raises(self):
        challenge = _make_challenge(self.member)
        mark_challenge_verified(challenge)
        with self.assertRaises(AuthChallengeInvalid):
            consume_verification_token(
                purpose=PURPOSE, verification_token="wrong", member=self.member
            )

    def test_challenge_can_only_transition_to_verified_once(self):
        challenge = _make_challenge(self.member)
        mark_challenge_verified(challenge)
        with self.assertRaises(AuthChallengeInvalid):
            mark_challenge_verified(challenge)


class QueriesTests(TestCase):
    def setUp(self):
        self.member = _make_member()

    def test_assert_within_limit_resend_cooldown(self):
        # A fresh pending challenge with last_sent_at == now triggers the cooldown branch.
        _make_challenge(self.member, last_sent_at=timezone.now())
        from apps.authn.services.email.challenges import AuthChallengeThrottled

        with self.assertRaises(AuthChallengeThrottled):
            assert_within_limit(
                member=self.member,
                purpose=PURPOSE,
                target_email="user@example.com",
                now=timezone.now(),
            )

    def test_get_latest_pending_returns_newest(self):
        _make_challenge(self.member)
        latest = get_latest_pending(purpose=PURPOSE, target_email="user@example.com")
        self.assertIsNotNone(latest)


class EmailAuthChallengeModelTests(TestCase):
    def setUp(self):
        self.member = _make_member()

    def test_str(self):
        challenge = _make_challenge(self.member)
        self.assertIn("user@example.com", str(challenge))

    def test_mark_expired_noop_when_already_expired(self):
        challenge = _make_challenge(self.member, status=EmailAuthChallenge.Status.EXPIRED)
        before = challenge.updated_at
        challenge.mark_expired()
        challenge.refresh_from_db()
        self.assertEqual(challenge.updated_at, before)

    def test_mark_verified_sets_status_and_timestamp(self):
        challenge = _make_challenge(self.member)
        challenge.mark_verified()
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.VERIFIED)
        self.assertIsNotNone(challenge.verified_at)

    def test_mark_consumed(self):
        challenge = _make_challenge(self.member)
        challenge.mark_consumed()
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.CONSUMED)

    def test_default_expiry_in_future(self):
        self.assertGreater(EmailAuthChallenge.default_expiry(), timezone.now())


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row-lock semantics")
class EmailChallengeConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.member = _make_member()

    @staticmethod
    def _run_concurrently(action):
        barrier = Barrier(2)

        def attempt():
            close_old_connections()
            barrier.wait()
            try:
                return action()
            except AuthChallengeInvalid:
                return None
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(lambda _: attempt(), range(2)))

    def test_only_one_caller_can_consume_a_correct_code(self):
        challenge = _make_challenge(self.member)

        def verify():
            return verify_email_code(
                purpose=PURPOSE,
                target_email="user@example.com",
                code="123456",
            ).pk

        results = self._run_concurrently(verify)
        self.assertEqual(sum(result is not None for result in results), 1)
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.CONSUMED)

    def test_only_one_caller_can_mint_a_verification_token(self):
        challenge = _make_challenge(self.member)

        def verify_and_mint():
            _, token = verify_email_code_and_mint_token(
                purpose=PURPOSE,
                target_email="user@example.com",
                code="123456",
                member=self.member,
            )
            return token

        results = self._run_concurrently(verify_and_mint)
        self.assertEqual(sum(result is not None for result in results), 1)
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.VERIFIED)
