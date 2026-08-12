from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail

Member = get_user_model()


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class ContactEmailAccessTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        self.member = Member.objects.create_user(
            password="StrongPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member,
            email_address="primary@example.com",
            email_type="primary",
            verified=True,
        )
        self.other_member = Member.objects.create_user(
            password="StrongPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.other_member,
            email_address="other@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_authenticate(user=self.member)

    # ── List ─────────────────────────────────────────────

    def test_cannot_access_other_users_email(self, _mock_code, _mock_send):
        contact = ContactEmail.objects.create(
            member=self.other_member,
            email_address="not-mine@example.com",
            email_type="other",
            verified=True,
        )
        self.client.get(f"/authn/contact-emails/{contact.pk}/")
        # Detail endpoint doesn't support GET, but PATCH/DELETE should 404
        patch_resp = self.client.patch(
            f"/authn/contact-emails/{contact.pk}/",
            {"subscribe": True},
            format="json",
        )
        self.assertEqual(patch_resp.status_code, 404)

        delete_resp = self.client.delete(f"/authn/contact-emails/{contact.pk}/")
        self.assertEqual(delete_resp.status_code, 404)

    def test_resend_verification_on_unverified(self, _mock_code, mock_send):
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "resend-me@example.com"},
            format="json",
        )
        contact_id = create_resp.data["id"]
        mock_send.reset_mock()

        # Clear cooldown
        from apps.authn.models.security import EmailAuthChallenge

        EmailAuthChallenge.objects.filter(target_email="resend-me@example.com").update(
            last_sent_at=None
        )

        resend_resp = self.client.post(f"/authn/contact-emails/{contact_id}/request-verification/")
        self.assertEqual(resend_resp.status_code, 202)
        mock_send.assert_called_once()

    def test_request_verification_is_rate_limited_per_user(self, _mock_code, _mock_send):
        # The shared email_code_request throttle is anon-only (a no-op once
        # authenticated); the per-user throttle (5/minute) must bound resends so a
        # logged-in caller cannot bomb an attacker-supplied address with codes.
        from django.core.cache import cache

        cache.clear()
        self.addCleanup(cache.clear)
        contact = ContactEmail.objects.create(
            member=self.member, email_address="bombing-target@example.com", email_type="other"
        )
        statuses = [
            self.client.post(
                f"/authn/contact-emails/{contact.pk}/request-verification/"
            ).status_code
            for _ in range(6)
        ]
        self.assertEqual(statuses[-1], 429)

    def test_resend_rejects_already_verified(self, _mock_code, _mock_send):
        contact = ContactEmail.objects.create(
            member=self.member,
            email_address="already-verified@example.com",
            email_type="other",
            verified=True,
        )
        response = self.client.post(f"/authn/contact-emails/{contact.pk}/request-verification/")
        self.assertEqual(response.status_code, 400)

    def test_profile_includes_email_subscribe(self, _mock_code, _mock_send):
        # Set primary email as subscribed
        primary = ContactEmail.objects.get(member=self.member, email_type="primary")
        primary.subscribe = True
        primary.save(update_fields=["subscribe"])

        response = self.client.get("/authn/profile/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("email_subscribe", response.data)
        self.assertTrue(response.data["email_subscribe"])

    def test_patch_profile_email_subscribe(self, _mock_code, _mock_send):
        # Start subscribed
        primary = ContactEmail.objects.get(member=self.member, email_type="primary")
        primary.subscribe = True
        primary.save(update_fields=["subscribe"])

        response = self.client.patch(
            "/authn/profile/",
            {"email_subscribe": False},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["email_subscribe"])

        primary.refresh_from_db()
        self.assertFalse(primary.subscribe)

    def test_unverified_email_excluded_from_account_emails(self, _mock_code, _mock_send):
        ContactEmail.objects.create(
            member=self.member,
            email_address="unverified@example.com",
            email_type="other",
            verified=False,
        )
        response = self.client.get("/authn/account-emails/")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("unverified@example.com", response.data["emails"])

    def test_verified_email_included_in_account_emails(self, _mock_code, _mock_send):
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "will-verify@example.com"},
            format="json",
        )
        contact_id = create_resp.data["id"]

        self.client.post(
            f"/authn/contact-emails/{contact_id}/verify-code/",
            {"code": "654321"},
            format="json",
        )

        response = self.client.get("/authn/account-emails/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("will-verify@example.com", response.data["emails"])

    def test_cannot_verify_other_users_email(self, _mock_code, _mock_send):
        """Verify that a user cannot verify another user's contact email."""
        # Create contact email for other_member
        self.client.force_authenticate(user=self.other_member)
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "other-contact@example.com"},
            format="json",
        )
        other_contact_id = create_resp.data["id"]

        # Switch to self.member and try to verify other_member's email
        self.client.force_authenticate(user=self.member)
        response = self.client.post(
            f"/authn/contact-emails/{other_contact_id}/verify-code/",
            {"code": "123456"},
            format="json",
        )
        self.assertEqual(response.status_code, 404)

    def test_cannot_request_verification_for_other_users_email(self, _mock_code, _mock_send):
        """Verify that a user cannot request verification for another user's contact email."""
        self.client.force_authenticate(user=self.other_member)
        create_resp = self.client.post(
            "/authn/contact-emails/",
            {"email_address": "other-contact2@example.com"},
            format="json",
        )
        other_contact_id = create_resp.data["id"]

        self.client.force_authenticate(user=self.member)
        response = self.client.post(
            f"/authn/contact-emails/{other_contact_id}/request-verification/",
            format="json",
        )
        self.assertEqual(response.status_code, 404)
