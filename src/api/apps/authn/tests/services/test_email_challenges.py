"""Tests for authn.services.email.challenges."""

from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase

from apps.authn.models import ContactEmail
from apps.authn.models.security import EmailAuthChallenge
from apps.authn.services.email.challenges import (
    MAX_CHALLENGES_PER_HOUR,
    AuthChallengeDeliveryError,
    AuthChallengeThrottled,
    issue_email_challenge,
    verify_email_code,
)

Member = get_user_model()

PURPOSE = EmailAuthChallenge.Purpose.ADMIN_LOGIN


class IssueEmailChallengeDeliveryFailureTests(TransactionTestCase):
    """Verify that a failed email send deletes the challenge so it does not pollute rate limits."""

    def setUp(self):
        self.member = Member.objects.create_user(
            password="TestPass123!", is_active=True, is_staff=True
        )
        ContactEmail.objects.create(
            member=self.member,
            email_address="admin@example.com",
            email_type="primary",
            verified=True,
        )

    @patch("apps.authn.services.email.challenges._random_code", return_value="123456")
    @patch(
        "apps.authn.services.email.send_email.send_verification_email",
        side_effect=RuntimeError("boom"),
    )
    def test_failed_delivery_deletes_challenge(self, _mock_send, _mock_code):
        """When email delivery fails the challenge record should be deleted."""
        with self.assertRaises(AuthChallengeDeliveryError):
            issue_email_challenge(
                member=self.member, purpose=PURPOSE, target_email="admin@example.com"
            )

        self.assertFalse(
            EmailAuthChallenge.objects.filter(member=self.member, purpose=PURPOSE).exists()
        )

    @patch("apps.authn.services.email.challenges._random_code", return_value="654321")
    @patch("apps.authn.services.email.send_email.send_verification_email")
    def test_retry_after_failed_delivery_succeeds(self, mock_send, _mock_code):
        """After a delivery failure the user can immediately retry without being throttled."""
        # First attempt: email send fails
        mock_send.side_effect = RuntimeError("boom")
        with self.assertRaises(AuthChallengeDeliveryError):
            issue_email_challenge(
                member=self.member, purpose=PURPOSE, target_email="admin@example.com"
            )

        # Second attempt: email send succeeds
        mock_send.side_effect = None
        challenge = issue_email_challenge(
            member=self.member, purpose=PURPOSE, target_email="admin@example.com"
        )
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.PENDING)

    @patch(
        "apps.authn.services.email.challenges.RESEND_COOLDOWN",
        timedelta(seconds=0),
    )
    @patch(
        "apps.authn.services.email.challenges._random_code",
        side_effect=["111111", "222222"],
    )
    @patch("apps.authn.services.email.send_email.send_verification_email")
    def test_failed_resend_keeps_previous_code_usable(self, mock_send, _mock_code):
        previous = issue_email_challenge(
            member=self.member,
            purpose=PURPOSE,
            target_email="admin@example.com",
        )

        mock_send.side_effect = RuntimeError("boom")
        with self.assertRaises(AuthChallengeDeliveryError):
            issue_email_challenge(
                member=self.member,
                purpose=PURPOSE,
                target_email="admin@example.com",
            )

        previous.refresh_from_db()
        self.assertEqual(previous.status, EmailAuthChallenge.Status.PENDING)
        self.assertEqual(
            EmailAuthChallenge.objects.filter(member=self.member, purpose=PURPOSE).count(),
            1,
        )

        verified = verify_email_code(
            member=self.member,
            purpose=PURPOSE,
            target_email="admin@example.com",
            code="111111",
        )
        self.assertEqual(verified.pk, previous.pk)
        self.assertEqual(verified.status, EmailAuthChallenge.Status.CONSUMED)

    @patch("apps.authn.services.email.challenges._random_code", return_value="111111")
    @patch("apps.authn.services.email.send_email.send_verification_email")
    def test_failed_deliveries_dont_exhaust_hourly_limit(self, mock_send, _mock_code):
        """Deleted challenges (from failed sends) must not count toward MAX_CHALLENGES_PER_HOUR."""
        mock_send.side_effect = RuntimeError("boom")

        # Simulate many consecutive delivery failures
        for _ in range(MAX_CHALLENGES_PER_HOUR):
            with self.assertRaises(AuthChallengeDeliveryError):
                issue_email_challenge(
                    member=self.member, purpose=PURPOSE, target_email="admin@example.com"
                )

        # All failed challenges should be deleted
        self.assertEqual(
            EmailAuthChallenge.objects.filter(member=self.member, purpose=PURPOSE).count(),
            0,
        )

        # Next attempt with a working send should succeed (not throttled)
        mock_send.side_effect = None
        challenge = issue_email_challenge(
            member=self.member, purpose=PURPOSE, target_email="admin@example.com"
        )
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.PENDING)

    @patch("apps.authn.services.email.challenges.RESEND_COOLDOWN", timedelta(seconds=0))
    @patch("apps.authn.services.email.challenges._random_code", return_value="222222")
    @patch("apps.authn.services.email.send_email.send_verification_email")
    def test_hourly_limit_still_enforced_for_successful_sends(self, mock_send, _mock_code):
        """Successful sends should still be counted toward the hourly limit."""
        for _ in range(MAX_CHALLENGES_PER_HOUR):
            issue_email_challenge(
                member=self.member, purpose=PURPOSE, target_email="admin@example.com"
            )

        with self.assertRaises(AuthChallengeThrottled):
            issue_email_challenge(
                member=self.member, purpose=PURPOSE, target_email="admin@example.com"
            )
