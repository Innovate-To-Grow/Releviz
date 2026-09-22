import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail
from apps.scheduling.models import (
    Event,
    EventResultInvalidation,
    Participant,
    RosterImportBatch,
    RosterImportReceipt,
    UserEvent,
)

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

    def test_confirm_delete_account_removes_organized_events_with_committed_roster_imports(
        self, _mock_code, _mock_send
    ):
        organized_event = Event.objects.create(
            code="DELETE2",
            name="Organized cascade",
            organizer=self.member,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        batch = RosterImportBatch.objects.create(
            event=organized_event,
            created_by=self.member,
            source_type=RosterImportBatch.SourceType.CSV,
            status=RosterImportBatch.Status.COMMITTED,
            expires_at=timezone.now() + timedelta(hours=1),
        )
        receipt = RosterImportReceipt.objects.create(
            event=organized_event,
            batch=batch,
            committed_by=self.member,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="f" * 64,
            mode=RosterImportReceipt.Mode.MERGE,
            results_revision=1,
        )
        # An organizer-managed person exists only through this organizer's event.
        managed_member = Member.objects.create_user(
            email="", first_name="Managed", is_active=True, access_level="temporary"
        )
        Participant.objects.create(
            member=managed_member,
            event=organized_event,
            participant_name="Managed Person",
            contact_email="delete-me@example.com",
            organizer_managed=True,
        )
        # A temporary participant with an address of their own is a real identity.
        temporary_member = Member.objects.create_user(
            email="temp@example.com", first_name="Temp", is_active=True, access_level="temporary"
        )
        Participant.objects.create(
            member=temporary_member,
            event=organized_event,
            participant_name="Temp Person",
        )

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
        self.assertFalse(Event.objects.filter(pk=organized_event.pk).exists())
        self.assertFalse(RosterImportBatch.objects.filter(pk=batch.pk).exists())
        self.assertFalse(RosterImportReceipt.objects.filter(pk=receipt.pk).exists())
        self.assertFalse(Member.objects.filter(pk=managed_member.pk).exists())
        self.assertTrue(Member.objects.filter(pk=temporary_member.pk).exists())

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
