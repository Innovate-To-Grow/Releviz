"""Phone deletion enforces the last-verified-recovery-contact rule (symmetric with email)."""

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.constants import LAST_RECOVERY_CONTACT_DELETE_FAILED
from apps.authn.models import ContactEmail, ContactPhone

Member = get_user_model()


def _url(pk):
    return f"/authn/contact-phones/{pk}/"


class PhoneDeletionPolicyTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(is_active=True, first_name="Del", last_name="Eter")
        self.client.force_authenticate(user=self.member)

    def _phone(self, number="2095551234", verified=True):
        return ContactPhone.objects.create(member=self.member, phone_number=number, region="1-US", verified=verified)

    def test_cannot_delete_last_verified_contact_phone(self):
        phone = self._phone()
        response = self.client.delete(_url(phone.id))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data, {"detail": LAST_RECOVERY_CONTACT_DELETE_FAILED})
        self.assertTrue(ContactPhone.objects.filter(pk=phone.pk).exists())

    def test_delete_phone_allowed_when_verified_email_remains(self):
        ContactEmail.objects.create(
            member=self.member, email_address="a@example.com", email_type="primary", verified=True
        )
        phone = self._phone()
        response = self.client.delete(_url(phone.id))
        self.assertEqual(response.status_code, 204)
        self.assertFalse(ContactPhone.objects.filter(pk=phone.pk).exists())

    def test_delete_phone_allowed_when_another_verified_phone_remains(self):
        first = self._phone("2095551234")
        self._phone("2095559999")
        response = self.client.delete(_url(first.id))
        self.assertEqual(response.status_code, 204)

    def test_unverified_phone_always_deletable(self):
        ContactEmail.objects.create(
            member=self.member, email_address="a@example.com", email_type="primary", verified=True
        )
        phone = self._phone(verified=False)
        response = self.client.delete(_url(phone.id))
        self.assertEqual(response.status_code, 204)

    def test_unverified_sole_phone_is_deletable(self):
        # An unverified phone is never a recovery contact, so removing it is allowed
        # even when it is the member's only contact.
        phone = self._phone(verified=False)
        response = self.client.delete(_url(phone.id))
        self.assertEqual(response.status_code, 204)
