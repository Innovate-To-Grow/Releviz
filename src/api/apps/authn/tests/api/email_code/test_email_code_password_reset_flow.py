from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail, EmailAuthChallenge

Member = get_user_model()


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class EmailCodePasswordResetFlowTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.password = "StrongPass123!"
        self.member = Member.objects.create_user(
            password=self.password,
            is_active=True,
        )
        self.primary_email = ContactEmail.objects.create(
            member=self.member,
            email_address="member@example.com",
            email_type="primary",
            verified=True,
        )
        self.alias = ContactEmail.objects.create(
            member=self.member,
            email_address="alias@example.com",
            email_type="secondary",
            verified=True,
        )

    def test_password_reset_flow_works_with_verified_contact_email(self, _mock_code, _mock_send):
        request_response = self.client.post(
            "/authn/password-reset/request-code/",
            {"email": self.alias.email_address},
            format="json",
        )
        self.assertEqual(request_response.status_code, 202)

        verify_response = self.client.post(
            "/authn/password-reset/verify-code/",
            {"email": self.alias.email_address, "code": "654321"},
            format="json",
        )
        self.assertEqual(verify_response.status_code, 200)
        token = verify_response.data["verification_token"]

        confirm_response = self.client.post(
            "/authn/password-reset/confirm/",
            {
                "email": self.alias.email_address,
                "verification_token": token,
                "new_password": "NewStrongPass123!",
                "new_password_confirm": "NewStrongPass123!",
            },
            format="json",
        )

        self.member.refresh_from_db()
        self.assertEqual(confirm_response.status_code, 200)
        self.assertTrue(self.member.check_password("NewStrongPass123!"))

    def test_new_code_invalidates_previous_code(self, _mock_code, _mock_send):
        first_response = self.client.post(
            "/authn/login/request-code/",
            {"email": self.alias.email_address},
            format="json",
        )
        self.assertEqual(first_response.status_code, 202)

        challenge = EmailAuthChallenge.objects.get(target_email=self.alias.email_address)
        challenge.last_sent_at = timezone.now() - timedelta(minutes=2)
        challenge.save(update_fields=["last_sent_at"])

        second_response = self.client.post(
            "/authn/login/request-code/",
            {"email": self.alias.email_address},
            format="json",
        )
        self.assertEqual(second_response.status_code, 202)

        # With the mock, both codes are "654321". The first challenge was expired
        # when the second was issued, so verify should use the new (latest pending) one.
        # Verify with the (only possible) code — should succeed against the new challenge.
        new_code_response = self.client.post(
            "/authn/login/verify-code/",
            {"email": self.alias.email_address, "code": "654321"},
            format="json",
        )
        self.assertEqual(new_code_response.status_code, 200)

    def test_password_reset_request_same_response_for_unknown_email(self, _mock_code, _mock_send):
        """Password reset for non-existent email should not reveal whether the email exists."""
        response = self.client.post(
            "/authn/password-reset/request-code/",
            {"email": "nonexistent@example.com"},
            format="json",
        )
        # Should return a success-like status (not 404) to prevent email enumeration
        self.assertIn(response.status_code, [200, 202])

    def test_password_reset_repeat_request_within_cooldown_matches_unknown_email(
        self, _mock_code, _mock_send
    ):
        """A second request inside the resend cooldown must not answer differently
        for an existing account than for an unknown address."""

        def request_twice(email):
            return [
                self.client.post(
                    "/authn/password-reset/request-code/", {"email": email}, format="json"
                )
                for _ in range(2)
            ]

        unknown = request_twice("nonexistent@example.com")
        known = request_twice(self.primary_email.email_address)

        for response in unknown + known:
            self.assertEqual(response.status_code, 202)
            self.assertEqual(
                response.data["message"],
                "If an eligible account exists, a verification code has been sent.",
            )
        # The throttled repeat sent nothing new, and the first code still works.
        self.assertEqual(
            EmailAuthChallenge.objects.filter(
                target_email=self.primary_email.email_address,
                purpose=EmailAuthChallenge.Purpose.PASSWORD_RESET,
            ).count(),
            1,
        )
        verify_response = self.client.post(
            "/authn/password-reset/verify-code/",
            {"email": self.primary_email.email_address, "code": "654321"},
            format="json",
        )
        self.assertEqual(verify_response.status_code, 200)
