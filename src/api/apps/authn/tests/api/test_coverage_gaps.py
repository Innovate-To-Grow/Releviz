"""Coverage gaps for API views: change_password, email_code_helpers, unsubscribe_login."""

from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from apps.authn.models import ContactEmail

Member = get_user_model()


# ---------------------------------------------------------------------------
# views/account/change_password.py:53-54  (TokenError on blacklist)
# ---------------------------------------------------------------------------
class ChangePasswordTokenErrorTests(TestCase):
    def test_invalid_refresh_token_logs_warning_and_succeeds(self):
        """change_password.py:53-54 — bad refresh token logs warning, password still changes."""
        from rest_framework.test import APIClient

        member = Member.objects.create_user(
            first_name="CP", last_name="User", password="OldPass123!", is_active=True
        )
        ContactEmail.objects.create(
            member=member, email_address="cp@example.com", email_type="primary", verified=True
        )
        client = APIClient()
        client.force_authenticate(member)

        with (
            patch(
                "apps.authn.serializers.account.change_password.ChangePasswordSerializer.is_valid",
                return_value=True,
            ),
            patch(
                "apps.authn.serializers.account.change_password.ChangePasswordSerializer.validated_data",
                new={"_decrypted_new_password": "BrandNewPass123!"},
                create=True,
            ),
            self.assertLogs("apps.authn.views.account.change_password", level="WARNING") as logs,
        ):
            response = client.post(
                "/authn/change-password/",
                {"refresh": "not-a-valid-jwt-token"},
                format="json",
            )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access", response.data)
        self.assertTrue(any("Unable to invalidate the prior session" in m for m in logs.output))
        member.refresh_from_db()
        self.assertTrue(member.check_password("BrandNewPass123!"))


# ---------------------------------------------------------------------------
# views/auth/email_code_helpers.py:15, 32
# ---------------------------------------------------------------------------
class EmailCodeHelperResponseTests(SimpleTestCase):
    def test_request_code_invalid_serializer_returns_400(self):
        """email_code_helpers.py:15 — invalid serializer -> 400 with errors."""
        from apps.authn.views.auth import email_code_helpers

        request = SimpleNamespace(data={})

        class _Serializer:
            def __init__(self, data=None):
                self.errors = {"email": ["required"]}

            def is_valid(self):
                return False

        response = email_code_helpers.request_code_response(request, _Serializer)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {"email": ["required"]})

    def test_auth_challenge_invalid_returns_400(self):
        """email_code_helpers.py:32 — AuthChallengeInvalid on save -> 400 generic detail."""
        from apps.authn.constants import VERIFICATION_INVALID
        from apps.authn.services import AuthChallengeInvalid
        from apps.authn.views.auth import email_code_helpers

        request = SimpleNamespace(data={})

        class _Serializer:
            def __init__(self, data=None):
                pass

            def is_valid(self):
                return True

            def save(self):
                raise AuthChallengeInvalid("bad")

        response = email_code_helpers.auth_challenge_response(request, _Serializer)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {"detail": VERIFICATION_INVALID})


# ---------------------------------------------------------------------------
# views/unsubscribe_login.py:32  (_send_unsubscribe_confirmation no primary email)
# ---------------------------------------------------------------------------
class UnsubscribeConfirmationTests(TestCase):
    def test_no_primary_email_skips_send(self):
        """unsubscribe_login.py:32 — member without primary email -> send_notification_email not called."""
        import apps.authn.views.account.unsubscribe_login as unsubscribe_login

        member = Member.objects.create_user(first_name="No", last_name="Email", is_active=True)

        with patch("apps.authn.services.email.send_notification_email") as send_mock:
            unsubscribe_login._send_unsubscribe_confirmation(member, "event-token")

        send_mock.assert_not_called()
