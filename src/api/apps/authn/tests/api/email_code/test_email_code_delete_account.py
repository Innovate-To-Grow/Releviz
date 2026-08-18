from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail
from apps.scheduling.models import Event, EventResultInvalidation, Participant, UserEvent

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
        organizer = Member.objects.create_user(password="OrganizerPass123!", is_active=True)
        self.event = Event.objects.create(
            code="DELETE1",
            name="Deletion cascade",
            organizer=organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        self.user_event = UserEvent.objects.create(
            member=self.member,
            event=self.event,
            role="participant",
        )
        self.participant = Participant.objects.create(
            member=self.member,
            event=self.event,
            participant_name="Delete Me",
            availability_inperson=[1, 1],
            availability_virtual=[1, 1],
            submitted=True,
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
        self.assertFalse(UserEvent.objects.filter(pk=self.user_event.pk).exists())
        self.assertTrue(
            EventResultInvalidation.objects.filter(
                event=self.event,
                processed_at__isnull=True,
            ).exists()
        )

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
