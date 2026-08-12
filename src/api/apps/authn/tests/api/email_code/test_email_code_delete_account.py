from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail
# FIXME(stale): apps.event removed during restructuring — test needs updating
# from apps.event.models import EventRegistration
# from apps.event.tests.helpers import make_event, make_ticket

Member = get_user_model()


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class EmailCodeDeleteAccountTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Delete",
            last_name="Me",
            is_active=True,
        )
        self.primary_email = ContactEmail.objects.create(
            member=self.member,
            email_address="delete-me@example.com",
            email_type="primary",
            verified=True,
        )
        event = make_event()
        ticket = make_ticket(event)
        self.registration = EventRegistration.objects.create(
            member=self.member, event=event, ticket=ticket
        )
        self.client.force_authenticate(user=self.member)

    def test_request_delete_account_code(self, _mock_code, mock_send):
        response = self.client.post("/authn/delete-account/request-code/", {}, format="json")
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.data["message"], "Deletion verification code sent.")
        mock_send.assert_called_once()

    def test_verify_delete_account_code_rejects_wrong_code(self, _mock_code, _mock_send):
        self.client.post("/authn/delete-account/request-code/", {}, format="json")

        response = self.client.post(
            "/authn/delete-account/verify-code/",
            {"code": "000000"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("detail", response.data)

    def test_confirm_delete_account_removes_member_and_related_records(
        self, _mock_code, _mock_send
    ):
        self.client.post("/authn/delete-account/request-code/", {}, format="json")
        verify_response = self.client.post(
            "/authn/delete-account/verify-code/",
            {"code": "654321"},
            format="json",
        )
        self.assertEqual(verify_response.status_code, 200)
        token = verify_response.data["verification_token"]

        confirm_response = self.client.post(
            "/authn/delete-account/confirm/",
            {"verification_token": token},
            format="json",
        )
        self.assertEqual(confirm_response.status_code, 200)
        self.assertEqual(confirm_response.data["message"], "Account deleted successfully.")

        self.assertFalse(Member.objects.filter(pk=self.member.pk).exists())
        self.assertFalse(ContactEmail.objects.filter(pk=self.primary_email.pk).exists())
        self.assertFalse(EventRegistration.objects.filter(pk=self.registration.pk).exists())

    def test_confirm_delete_account_rejects_other_users_token(self, _mock_code, _mock_send):
        self.client.post("/authn/delete-account/request-code/", {}, format="json")
        verify_response = self.client.post(
            "/authn/delete-account/verify-code/",
            {"code": "654321"},
            format="json",
        )
        self.assertEqual(verify_response.status_code, 200)
        token = verify_response.data["verification_token"]

        other_member = Member.objects.create_user(password="OtherPass123!", is_active=True)
        ContactEmail.objects.create(
            member=other_member,
            email_address="other-delete@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_authenticate(user=other_member)

        confirm_response = self.client.post(
            "/authn/delete-account/confirm/",
            {"verification_token": token},
            format="json",
        )
        self.assertEqual(confirm_response.status_code, 400)
        self.assertTrue(Member.objects.filter(pk=self.member.pk).exists())
