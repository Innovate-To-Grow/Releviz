from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail

Member = get_user_model()


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class EmailCodePasswordChangeTests(APITestCase):
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

    def test_authenticated_password_change_code_flow_uses_own_verified_emails(
        self, _mock_code, _mock_send
    ):
        other_member = Member.objects.create_user(
            password="OtherPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=other_member,
            email_address="other@example.com",
            email_type="primary",
            verified=True,
        )
        other_alias = ContactEmail.objects.create(
            member=other_member,
            email_address="other-alias@example.com",
            email_type="secondary",
            verified=True,
        )

        self.client.force_authenticate(user=self.member)

        list_response = self.client.get("/authn/account-emails/")
        self.assertEqual(list_response.status_code, 200)
        self.assertIn(self.primary_email.email_address, list_response.data["emails"])
        self.assertIn(self.alias.email_address, list_response.data["emails"])

        invalid_request = self.client.post(
            "/authn/change-password/request-code/",
            {"email": other_alias.email_address},
            format="json",
        )
        self.assertEqual(invalid_request.status_code, 400)

        valid_request = self.client.post(
            "/authn/change-password/request-code/",
            {"email": self.alias.email_address},
            format="json",
        )
        self.assertEqual(valid_request.status_code, 202)

        verify_response = self.client.post(
            "/authn/change-password/verify-code/",
            {"email": self.alias.email_address, "code": "654321"},
            format="json",
        )
        self.assertEqual(verify_response.status_code, 200)
        token = verify_response.data["verification_token"]

        confirm_response = self.client.post(
            "/authn/change-password/confirm/",
            {
                "verification_token": token,
                "new_password": "CodeChangedPass123!",
                "new_password_confirm": "CodeChangedPass123!",
            },
            format="json",
        )

        self.member.refresh_from_db()
        self.assertEqual(confirm_response.status_code, 200)
        self.assertTrue(self.member.check_password("CodeChangedPass123!"))

    def test_password_reset_confirm_requires_matching_email(self, _mock_code, _mock_send):
        """Correct token but wrong identifier → 400 with a uniform error (no enumeration)."""
        # Request + verify code for member
        self.client.post(
            "/authn/password-reset/request-code/",
            {"email": self.primary_email.email_address},
            format="json",
        )
        verify_response = self.client.post(
            "/authn/password-reset/verify-code/",
            {"email": self.primary_email.email_address, "code": "654321"},
            format="json",
        )
        self.assertEqual(verify_response.status_code, 200)
        token = verify_response.data["verification_token"]

        # Try to confirm with a non-existent email
        confirm_response = self.client.post(
            "/authn/password-reset/confirm/",
            {
                "email": "nobody@example.com",
                "verification_token": token,
                "new_password": "ResetPass123!",
                "new_password_confirm": "ResetPass123!",
            },
            format="json",
        )
        self.assertEqual(confirm_response.status_code, 400)
        self.assertIn("Verification token is invalid", str(confirm_response.data))

    def test_password_reset_confirm_rejects_other_users_token(self, _mock_code, _mock_send):
        """Member B's email + member A's token → 400 'Verification token is invalid' (S10 fix)."""
        other_member = Member.objects.create_user(
            password="OtherPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=other_member,
            email_address="other-reset@example.com",
            email_type="primary",
            verified=True,
        )

        # Request + verify code for self.member (member A)
        self.client.post(
            "/authn/password-reset/request-code/",
            {"email": self.primary_email.email_address},
            format="json",
        )
        verify_response = self.client.post(
            "/authn/password-reset/verify-code/",
            {"email": self.primary_email.email_address, "code": "654321"},
            format="json",
        )
        self.assertEqual(verify_response.status_code, 200)
        token_a = verify_response.data["verification_token"]

        # Try to use member A's token with member B's email
        confirm_response = self.client.post(
            "/authn/password-reset/confirm/",
            {
                "email": "other-reset@example.com",
                "verification_token": token_a,
                "new_password": "ResetPass123!",
                "new_password_confirm": "ResetPass123!",
            },
            format="json",
        )
        self.assertEqual(confirm_response.status_code, 400)
        self.assertIn("Verification token is invalid", str(confirm_response.data))
