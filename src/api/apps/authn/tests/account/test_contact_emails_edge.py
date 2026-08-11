"""Edge-case coverage for contact email views and the account/email_code views."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail
from apps.authn.services import AuthChallengeDeliveryError, AuthChallengeInvalid

Member = get_user_model()


class ContactEmailViewEdgeTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=self.member, email_address="primary@example.com", email_type="primary", verified=True
        )
        self.client.force_authenticate(user=self.member)

    @patch("apps.authn.views.account.contact_emails.create_contact_email")
    def test_create_delivery_error_returns_503(self, mock_create):
        mock_create.side_effect = AuthChallengeDeliveryError("ses down")
        resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "new@example.com", "email_type": "secondary"},
            format="json",
        )
        self.assertEqual(resp.status_code, 503)

    @patch("apps.authn.views.account.contact_emails.create_contact_email")
    def test_create_auth_challenge_invalid_returns_400(self, mock_create):
        mock_create.side_effect = AuthChallengeInvalid("dup")
        resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "new@example.com", "email_type": "secondary"},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_request_verification_not_found(self):
        import uuid

        resp = self.client.post(f"/authn/contact-emails/{uuid.uuid4()}/request-verification/")
        self.assertEqual(resp.status_code, 404)

    def test_request_verification_already_verified(self):
        verified = ContactEmail.objects.create(
            member=self.member, email_address="ver@example.com", email_type="secondary", verified=True
        )
        resp = self.client.post(f"/authn/contact-emails/{verified.pk}/request-verification/")
        self.assertEqual(resp.status_code, 400)

    @patch("apps.authn.views.account.contact_emails.resend_contact_email_verification")
    def test_request_verification_delivery_error_returns_503(self, mock_resend):
        mock_resend.side_effect = AuthChallengeDeliveryError("ses down")
        unverified = ContactEmail.objects.create(
            member=self.member, email_address="unv@example.com", email_type="secondary", verified=False
        )
        resp = self.client.post(f"/authn/contact-emails/{unverified.pk}/request-verification/")
        self.assertEqual(resp.status_code, 503)

    @patch("apps.authn.views.account.contact_emails.resend_contact_email_verification")
    def test_request_verification_auth_invalid_returns_400(self, mock_resend):
        mock_resend.side_effect = AuthChallengeInvalid("nope")
        unverified = ContactEmail.objects.create(
            member=self.member, email_address="unv2@example.com", email_type="secondary", verified=False
        )
        resp = self.client.post(f"/authn/contact-emails/{unverified.pk}/request-verification/")
        self.assertEqual(resp.status_code, 400)

    def test_verify_code_not_found(self):
        import uuid

        resp = self.client.post(f"/authn/contact-emails/{uuid.uuid4()}/verify-code/", {"code": "123456"}, format="json")
        self.assertEqual(resp.status_code, 404)

    def test_verify_code_invalid_payload(self):
        contact = ContactEmail.objects.create(
            member=self.member, email_address="vc@example.com", email_type="secondary", verified=False
        )
        resp = self.client.post(f"/authn/contact-emails/{contact.pk}/verify-code/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    @patch("apps.authn.views.account.contact_emails.verify_contact_email_code")
    def test_verify_code_auth_invalid_returns_400(self, mock_verify):
        mock_verify.side_effect = AuthChallengeInvalid("bad code")
        contact = ContactEmail.objects.create(
            member=self.member, email_address="vc2@example.com", email_type="secondary", verified=False
        )
        resp = self.client.post(f"/authn/contact-emails/{contact.pk}/verify-code/", {"code": "123456"}, format="json")
        self.assertEqual(resp.status_code, 400)

    @patch("apps.authn.views.account.contact_emails.verify_contact_email_code")
    def test_verify_code_delivery_error_returns_503(self, mock_verify):
        mock_verify.side_effect = AuthChallengeDeliveryError("ses down")
        contact = ContactEmail.objects.create(
            member=self.member, email_address="vc3@example.com", email_type="secondary", verified=False
        )
        resp = self.client.post(f"/authn/contact-emails/{contact.pk}/verify-code/", {"code": "123456"}, format="json")
        self.assertEqual(resp.status_code, 503)

    def test_delete_not_found(self):
        import uuid

        resp = self.client.delete(f"/authn/contact-emails/{uuid.uuid4()}/")
        self.assertEqual(resp.status_code, 404)

    def test_make_primary_not_found(self):
        import uuid

        resp = self.client.post(f"/authn/contact-emails/{uuid.uuid4()}/make-primary/")
        self.assertEqual(resp.status_code, 404)

    @patch("apps.authn.views.account.contact_emails.make_contact_email_primary")
    def test_make_primary_auth_invalid_returns_400(self, mock_make):
        mock_make.side_effect = AuthChallengeInvalid("not verified")
        contact = ContactEmail.objects.create(
            member=self.member, email_address="mp@example.com", email_type="secondary", verified=True
        )
        resp = self.client.post(f"/authn/contact-emails/{contact.pk}/make-primary/")
        self.assertEqual(resp.status_code, 400)

    @patch("apps.authn.views.account.contact_emails.make_contact_email_primary")
    def test_make_primary_delivery_error_returns_503(self, mock_make):
        mock_make.side_effect = AuthChallengeDeliveryError("ses down")
        contact = ContactEmail.objects.create(
            member=self.member, email_address="mp2@example.com", email_type="secondary", verified=True
        )
        resp = self.client.post(f"/authn/contact-emails/{contact.pk}/make-primary/")
        self.assertEqual(resp.status_code, 503)


class AccountEmailCodeViewEdgeTests(APITestCase):
    """Covers the authenticated change-password / delete-account code views."""

    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=self.member, email_address="user@example.com", email_type="primary", verified=True
        )
        self.client.force_authenticate(user=self.member)

    @patch("apps.authn.services.email.send_email.send_verification_email")
    def test_change_password_request_without_email_selects_verified_email(self, _mock_send):
        # An empty payload is now valid: the backend auto-selects the verification
        # channel (the member's verified email here), mirroring the phone-only SMS path.
        resp = self.client.post("/authn/change-password/request-code/", {}, format="json")
        self.assertEqual(resp.status_code, 202)
        self.assertEqual(resp.data["channel"], "email")

    def test_change_password_request_without_recovery_contact_returns_400(self):
        # A member with no verified email or phone has no channel to verify through.
        member = Member.objects.create_user(password="StrongPass123!", is_active=True)
        self.client.force_authenticate(user=member)
        resp = self.client.post("/authn/change-password/request-code/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    @patch("apps.authn.serializers.email_code.passwords.ChangePasswordCodeRequestSerializer.save")
    def test_change_password_request_delivery_error_returns_503(self, mock_save):
        mock_save.side_effect = AuthChallengeDeliveryError("ses down")
        resp = self.client.post(
            "/authn/change-password/request-code/",
            {"email": "user@example.com"},
            format="json",
        )
        self.assertEqual(resp.status_code, 503)

    def test_change_password_verify_invalid_payload(self):
        resp = self.client.post("/authn/change-password/verify-code/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_change_password_confirm_invalid_payload(self):
        resp = self.client.post("/authn/change-password/confirm/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    @patch("apps.authn.serializers.email_code.passwords.ChangePasswordCodeConfirmSerializer.save")
    def test_change_password_confirm_auth_invalid_returns_400(self, mock_save):
        mock_save.side_effect = AuthChallengeInvalid("expired")
        resp = self.client.post(
            "/authn/change-password/confirm/",
            {
                "verification_token": "tok",
                "new_password": "BrandNewPass123!",
                "new_password_confirm": "BrandNewPass123!",
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_delete_account_verify_invalid_payload(self):
        resp = self.client.post("/authn/delete-account/verify-code/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    @patch("apps.authn.serializers.email_code.passwords.DeleteAccountCodeRequestSerializer.save")
    def test_delete_account_request_delivery_error_returns_503(self, mock_save):
        mock_save.side_effect = AuthChallengeDeliveryError("ses down")
        resp = self.client.post("/authn/delete-account/request-code/", {}, format="json")
        self.assertEqual(resp.status_code, 503)

    def test_delete_account_verify_invalid_code_format_returns_400(self):
        resp = self.client.post("/authn/delete-account/verify-code/", {"code": "abcdef"}, format="json")
        self.assertEqual(resp.status_code, 400)
