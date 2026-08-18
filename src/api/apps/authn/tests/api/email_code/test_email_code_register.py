from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail

Member = get_user_model()


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class EmailCodeAuthRegisterTests(APITestCase):
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

    def test_register_creates_inactive_member_then_activates_on_verify(self, _mock_code, mock_send):
        response = self.client.post(
            "/authn/register/",
            {
                "email": "new-member@example.com",
                "password": self.password,
                "password_confirm": self.password,
                "first_name": "New",
                "last_name": "Member",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(mock_send.call_args.kwargs["link_flow"], "register")
        self.assertEqual(mock_send.call_args.kwargs["link_source"], "register")
        contact = ContactEmail.objects.get(email_address="new-member@example.com")
        member = contact.member
        self.assertFalse(member.is_active)
        self.assertTrue(contact.subscribe)

        verify_response = self.client.post(
            "/authn/register/verify-code/",
            {"email": "new-member@example.com", "code": "654321"},
            format="json",
        )

        member.refresh_from_db()
        contact.refresh_from_db()
        self.assertEqual(verify_response.status_code, 200)
        self.assertTrue(member.is_active)
        self.assertTrue(contact.subscribe)
        self.assertIn("access", verify_response.data)

    def test_jwt_failure_rolls_back_activation_contact_and_code(self, _mock_code, _mock_send):
        self.client.post(
            "/authn/register/",
            {
                "email": "rollback@example.com",
                "password": self.password,
                "password_confirm": self.password,
                "first_name": "Roll",
                "last_name": "Back",
            },
            format="json",
        )
        contact = ContactEmail.objects.get(email_address="rollback@example.com")
        member = contact.member
        challenge = member.email_auth_challenges.get()

        with patch(
            "apps.authn.views.helpers.issue_session_refresh_token",
            side_effect=RuntimeError("JWT creation failed"),
        ):
            with self.assertRaisesMessage(RuntimeError, "JWT creation failed"):
                self.client.post(
                    "/authn/register/verify-code/",
                    {"email": "rollback@example.com", "code": "654321"},
                    format="json",
                )

        member.refresh_from_db()
        contact.refresh_from_db()
        challenge.refresh_from_db()
        self.assertFalse(member.is_active)
        self.assertFalse(contact.verified)
        self.assertEqual(challenge.status, challenge.Status.PENDING)

    def test_register_reuses_pending_member(self, _mock_code, _mock_send):
        pending = Member.objects.create_user(
            password="OldPass123!",
            is_active=False,
            first_name="Old",
        )
        ContactEmail.objects.create(
            member=pending,
            email_address="pending@example.com",
            email_type="primary",
            verified=False,
        )

        response = self.client.post(
            "/authn/register/",
            {
                "email": "pending@example.com",
                "password": self.password,
                "password_confirm": self.password,
                "first_name": "Updated",
                "last_name": "User",
            },
            format="json",
        )

        pending.refresh_from_db()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(
            ContactEmail.objects.filter(email_address="pending@example.com").count(), 1
        )
        self.assertEqual(pending.first_name, "Updated")
        self.assertTrue(pending.check_password(self.password))
        self.assertTrue(
            ContactEmail.objects.get(email_address="pending@example.com").subscribe,
        )

    def test_register_claims_unowned_subscriber_contact(self, _mock_code, _mock_send):
        ContactEmail.objects.create(
            email_address="subscriber@example.com",
            email_type="other",
            subscribe=True,
        )

        response = self.client.post(
            "/authn/register/",
            {
                "email": "subscriber@example.com",
                "password": self.password,
                "password_confirm": self.password,
                "first_name": "Sub",
                "last_name": "Scriber",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(
            ContactEmail.objects.filter(email_address="subscriber@example.com").count(), 1
        )
        contact = ContactEmail.objects.get(email_address="subscriber@example.com")
        self.assertIsNotNone(contact.member)
        self.assertEqual(contact.email_type, "primary")
        self.assertFalse(contact.verified)
        self.assertTrue(contact.subscribe)
        self.assertEqual(contact.member.first_name, "Sub")

    def test_register_rejects_existing_contact_email(self, _mock_code, _mock_send):
        response = self.client.post(
            "/authn/register/",
            {
                "email": self.alias.email_address,
                "password": self.password,
                "password_confirm": self.password,
                "first_name": "Alias",
                "last_name": "Conflict",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Unable to register", response.data["email"][0])
