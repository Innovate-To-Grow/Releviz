from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail

Member = get_user_model()

SESSION_URL = "/authn/session/"


class SessionViewTests(APITestCase):
    def test_authentication_is_required(self):
        response = self.client.get(SESSION_URL)

        self.assertEqual(response.status_code, 401)

    def test_returns_current_serialized_user_and_completed_next_step(self):
        member = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Ada",
            last_name="Lovelace",
            is_active=True,
        )
        primary = ContactEmail.objects.create(
            member=member,
            email_address="ada@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_authenticate(member)

        response = self.client.get(SESSION_URL)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["user"]["member_uuid"], str(member.pk))
        self.assertEqual(response.data["user"]["email"], primary.email_address)
        self.assertTrue(response.data["user"]["email_verified"])
        self.assertFalse(response.data["requires_profile_completion"])
        self.assertEqual(response.data["next_step"], "account")

    def test_incomplete_profile_returns_completion_next_step(self):
        member = Member.objects.create_user(
            password="StrongPass123!",
            first_name="",
            last_name="",
            is_active=True,
        )
        self.client.force_authenticate(member)

        response = self.client.get(SESSION_URL)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["requires_profile_completion"])
        self.assertEqual(response.data["next_step"], "complete_profile")
