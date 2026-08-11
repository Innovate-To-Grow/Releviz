"""The first contact email is auto-assigned primary; a later email never replaces it."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail, ContactPhone

Member = get_user_model()

CREATE_URL = "/authn/contact-emails/"


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class FirstEmailPrimaryTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(is_active=True, first_name="Pat", last_name="Phone")
        self.member.set_unusable_password()
        self.member.save()
        ContactPhone.objects.create(member=self.member, phone_number="2095551234", region="1-US", verified=True)
        self.client.force_authenticate(user=self.member)

    def test_first_email_is_assigned_primary_and_not_marked_verified(self, _mock_code, _mock_send):
        response = self.client.post(
            CREATE_URL, {"email_address": "first@example.com", "email_type": "secondary"}, format="json"
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["email_type"], "primary")
        self.assertFalse(response.data["verified"])  # primary status is independent of verification

    def test_second_email_does_not_replace_existing_primary(self, _mock_code, _mock_send):
        ContactEmail.objects.create(
            member=self.member, email_address="primary@example.com", email_type="primary", verified=True
        )
        response = self.client.post(
            CREATE_URL, {"email_address": "second@example.com", "email_type": "secondary"}, format="json"
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["email_type"], "secondary")
        primary = ContactEmail.objects.get(member=self.member, email_type="primary")
        self.assertEqual(primary.email_address, "primary@example.com")
