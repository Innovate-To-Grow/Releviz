"""Email deletion policy: keep a verified recovery contact, reassign primary atomically."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.constants import LAST_RECOVERY_CONTACT_DELETE_FAILED
from apps.authn.models import ContactEmail, ContactPhone

Member = get_user_model()


def _url(pk):
    return f"/authn/contact-emails/{pk}/"


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class EmailDeletionPolicyTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(is_active=True, first_name="Del", last_name="Eter")
        self.client.force_authenticate(user=self.member)

    def _verified_phone(self):
        return ContactPhone.objects.create(member=self.member, phone_number="2095551234", region="1-US", verified=True)

    def test_delete_only_email_allowed_when_verified_phone_remains(self, _mock_code, _mock_send):
        self._verified_phone()
        email = ContactEmail.objects.create(
            member=self.member, email_address="only@example.com", email_type="primary", verified=True
        )
        response = self.client.delete(_url(email.id))
        self.assertEqual(response.status_code, 204)
        self.assertFalse(ContactEmail.objects.filter(member=self.member).exists())

    def test_cannot_delete_last_verified_contact(self, _mock_code, _mock_send):
        email = ContactEmail.objects.create(
            member=self.member, email_address="last@example.com", email_type="primary", verified=True
        )
        response = self.client.delete(_url(email.id))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data, {"detail": LAST_RECOVERY_CONTACT_DELETE_FAILED})
        self.assertTrue(ContactEmail.objects.filter(pk=email.pk).exists())

    def test_deleting_primary_promotes_remaining_email(self, _mock_code, _mock_send):
        primary = ContactEmail.objects.create(
            member=self.member, email_address="primary@example.com", email_type="primary", verified=True
        )
        secondary = ContactEmail.objects.create(
            member=self.member, email_address="secondary@example.com", email_type="secondary", verified=True
        )
        response = self.client.delete(_url(primary.id))
        self.assertEqual(response.status_code, 204)
        secondary.refresh_from_db()
        self.assertEqual(secondary.email_type, "primary")

    def test_deleting_primary_prefers_verified_email_for_promotion(self, _mock_code, _mock_send):
        self._verified_phone()
        primary = ContactEmail.objects.create(
            member=self.member, email_address="primary@example.com", email_type="primary", verified=True
        )
        ContactEmail.objects.create(
            member=self.member, email_address="unverified@example.com", email_type="other", verified=False
        )
        verified_other = ContactEmail.objects.create(
            member=self.member, email_address="verified@example.com", email_type="secondary", verified=True
        )
        response = self.client.delete(_url(primary.id))
        self.assertEqual(response.status_code, 204)
        verified_other.refresh_from_db()
        self.assertEqual(verified_other.email_type, "primary")

    def test_unverified_email_is_always_deletable(self, _mock_code, _mock_send):
        ContactEmail.objects.create(
            member=self.member, email_address="primary@example.com", email_type="primary", verified=True
        )
        self._verified_phone()
        unverified = ContactEmail.objects.create(
            member=self.member, email_address="unverified@example.com", email_type="other", verified=False
        )
        response = self.client.delete(_url(unverified.id))
        self.assertEqual(response.status_code, 204)
