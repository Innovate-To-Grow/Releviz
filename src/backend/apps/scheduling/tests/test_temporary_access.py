import re
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core import mail
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.tests.helpers import create_member, token_for
from apps.messaging.models import EmailDeliveryJob, EmailDeliveryRequest
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    TemporaryEventSession,
)


class TemporaryParticipantAccessTests(TestCase):
    def setUp(self):
        self.organizer = create_member("organizer@example.com", "Event", "Owner")
        self.full_member = create_member("full@example.com", "Full", "Member")
        self.organizer_client = APIClient()
        self.organizer_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")
        self.event = Event.objects.create(
            code="TEMP123",
            name="Shared planning",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            participant_view_permission="realtime",
        )

    def create_managed(self, *, name="Managed Person", email="managed@example.com"):
        return self.organizer_client.post(
            f"/events/participants/managed?code={self.event.code}",
            {"name": name, "email": email},
            format="json",
        )

    def send_invitation(self, email="managed@example.com"):
        return self.organizer_client.post(
            f"/events/invitations?code={self.event.code}",
            {
                "emails": [email],
                "message": "Please add your time.",
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )

    def request_and_verify_temp_session(self):
        invitation = EventInvitation.objects.get(
            event=self.event,
            email="managed@example.com",
        )
        client = APIClient()
        with self.captureOnCommitCallbacks(execute=True):
            requested = client.post(
                "/events/temp-access/request-code",
                {
                    "code": self.event.code,
                    "invitationToken": str(invitation.access_token),
                },
                format="json",
            )
        self.assertEqual(requested.status_code, 202)
        match = re.search(r"\b(\d{6})\b", mail.outbox[-1].body)
        self.assertIsNotNone(match)
        verified = client.post(
            "/events/temp-access/verify",
            {
                "code": self.event.code,
                "invitationToken": str(invitation.access_token),
                "verificationCode": match.group(1),
            },
            format="json",
        )
        self.assertEqual(verified.status_code, 200, verified.data)
        return client, verified

    def test_managed_creation_reuses_global_identity_without_sending_mail(self):
        created = self.create_managed()
        self.assertEqual(created.status_code, 201, created.data)
        participant_id = created.data["participant"]["id"]
        self.assertEqual(created.data["participant"]["accountAccess"], "temporary")
        self.assertEqual(created.data["participant"]["email"], "managed@example.com")
        self.assertEqual(created.data["participant"]["invitationStatus"], "not_sent")
        self.assertTrue(created.data["participant"]["canOrganizerEditAvailability"])

        member = get_user_model().objects.get(pk=participant_id)
        self.assertEqual(member.access_level, member.AccessLevel.TEMPORARY)
        self.assertTrue(member.is_active)
        self.assertFalse(member.has_usable_password())
        self.assertFalse(ContactEmail.objects.get(member=member).verified)
        invitation = EventInvitation.objects.get(event=self.event, member=member)
        self.assertIsNone(invitation.first_sent_at)
        self.assertEqual(EmailDeliveryJob.objects.count(), 0)
        self.assertEqual(len(mail.outbox), 0)

        immutable = self.organizer_client.put(
            (f"/events/participants/update?code={self.event.code}&participantId={participant_id}"),
            {"email": "changed@example.com"},
            format="json",
        )
        self.assertEqual(immutable.status_code, 400)
        self.assertFalse(ContactEmail.objects.filter(email_address="changed@example.com").exists())

        duplicate = self.create_managed(
            name="A different submitted name",
            email=" MANAGED@example.com ",
        )
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.data["participant"]["id"], participant_id)
        self.assertEqual(duplicate.data["participant"]["name"], "Managed Person")
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 1)

        other_event = Event.objects.create(
            code="OTHER123",
            name="Other event",
            organizer=self.organizer,
            days=[2],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        reused = self.organizer_client.post(
            f"/events/participants/managed?code={other_event.code}",
            {"name": "Another display name", "email": "managed@example.com"},
            format="json",
        )
        self.assertEqual(reused.status_code, 201)
        self.assertEqual(reused.data["participant"]["id"], participant_id)
        self.assertEqual(
            ContactEmail.objects.filter(email_address="managed@example.com").count(),
            1,
        )

        full = self.create_managed(name="Organizer label", email="full@example.com")
        self.assertEqual(full.status_code, 201)
        self.assertEqual(full.data["participant"]["id"], str(self.full_member.pk))
        self.assertEqual(full.data["participant"]["accountAccess"], "full")
        self.assertFalse(full.data["participant"]["canOrganizerEditAvailability"])
        denied = self.organizer_client.put(
            (
                f"/events/participants/update?code={self.event.code}"
                f"&participantId={self.full_member.pk}"
            ),
            {
                "availabilityInperson": [1, 1],
                "submitted": 0,
                "expectedVersion": full.data["participant"]["version"],
            },
            format="json",
        )
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.data["errorCode"], "organizer_edit_full_account")
        self.assertEqual(denied.data["participant"]["accountAccess"], "full")

    def test_temporary_and_full_members_receive_the_correct_manual_links_and_resends(self):
        self.event.response_deadline = timezone.now() + timedelta(days=1)
        self.event.save(update_fields=["response_deadline", "updated_at"])
        self.create_managed()
        self.create_managed(name="Full Member", email="full@example.com")
        first = self.send_invitation()
        self.assertEqual(first.status_code, 201, first.data)
        self.assertEqual(first.data["enqueued"], 1)
        self.assertIn("/temp-access?code=TEMP123", mail.outbox[-1].body)
        self.assertIn("six-digit code", mail.outbox[-1].body)
        self.assertIn("/temp-access?code=TEMP123", mail.outbox[-1].attachments[0][1])

        full = self.send_invitation("full@example.com")
        self.assertEqual(full.status_code, 201)
        self.assertIn("/event?code=TEMP123", mail.outbox[-1].body)
        self.assertNotIn("/temp-access", mail.outbox[-1].body)

        resent = self.send_invitation()
        self.assertEqual(resent.status_code, 201)
        self.assertEqual(resent.data["enqueued"], 1)
        self.assertEqual(
            EmailDeliveryJob.objects.filter(recipient="managed@example.com").count(),
            2,
        )

    def test_cross_event_temp_invitation_requires_create_person_and_is_atomic(self):
        self.create_managed()
        other_event = Event.objects.create(
            code="OTHER456",
            name="Other organizer event",
            organizer=self.organizer,
            days=[2],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )

        response = self.organizer_client.post(
            f"/events/invitations?code={other_event.code}",
            {
                "emails": ["full@example.com", "managed@example.com"],
                "message": "Please add your time.",
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn("managed@example.com", response.data["error"])
        self.assertIn("Create person", response.data["error"])
        self.assertFalse(EventInvitation.objects.filter(event=other_event).exists())
        self.assertFalse(EmailDeliveryJob.objects.filter(event=other_event).exists())
        self.assertFalse(EmailDeliveryRequest.objects.filter(event=other_event).exists())
        self.assertEqual(len(mail.outbox), 0)

    @override_settings(TEMP_EVENT_COOKIE_SECURE=True)
    def test_scoped_temp_session_edits_the_shared_participant_with_version_conflicts(self):
        created = self.create_managed()
        participant_id = created.data["participant"]["id"]
        sent = self.send_invitation()
        self.assertEqual(sent.status_code, 201)
        invalid = APIClient().post(
            "/events/temp-access/request-code",
            {"code": "UNKNOWN", "invitationToken": str(uuid.uuid4())},
            format="json",
        )
        self.assertEqual(invalid.status_code, 202)
        self.assertEqual(
            invalid.data["message"],
            "If this access link is valid, a verification code has been sent.",
        )

        temp_client, verified = self.request_and_verify_temp_session()
        self.assertEqual(verified.data["participant"]["id"], participant_id)
        self.assertEqual(verified.data["email"], "managed@example.com")
        cookie = verified.cookies["releviz_temp_event"]
        self.assertTrue(cookie["httponly"])
        self.assertTrue(cookie["secure"])
        self.assertEqual(cookie["samesite"], "Lax")
        self.assertEqual(cookie["path"], "/events/temp-access/")
        session_record = TemporaryEventSession.objects.get()
        raw_secret = cookie.value.split(".", 1)[1]
        self.assertNotEqual(session_record.secret_hash, raw_secret)
        self.assertGreater(session_record.expires_at, timezone.now() + timedelta(days=6))

        session = temp_client.get(f"/events/temp-access/session?code={self.event.code}")
        self.assertEqual(session.status_code, 200)
        self.assertEqual(session.data["participant"]["id"], participant_id)
        self.assertEqual(temp_client.get("/dashboard/events").status_code, 401)
        self.assertEqual(
            temp_client.post("/events", {"name": "Forbidden"}, format="json").status_code,
            401,
        )

        organizer_update = self.organizer_client.put(
            (f"/events/participants/update?code={self.event.code}&participantId={participant_id}"),
            {
                "name": "Organizer edited",
                "availabilityInperson": [1, 0],
                "availabilityVirtual": [0, 1],
                "submitted": 0,
                "expectedVersion": verified.data["participant"]["version"],
            },
            format="json",
        )
        self.assertEqual(organizer_update.status_code, 200, organizer_update.data)

        conflict = temp_client.put(
            f"/events/temp-access/participant?code={self.event.code}",
            {
                "availabilityInperson": [1, 1],
                "submitted": 1,
                "expectedVersion": verified.data["participant"]["version"],
            },
            format="json",
            HTTP_ORIGIN="http://testserver",
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(
            conflict.data["participant"]["version"],
            organizer_update.data["participant"]["version"],
        )

        rejected_origin = temp_client.put(
            f"/events/temp-access/participant?code={self.event.code}",
            {
                "availabilityInperson": [1, 1],
                "submitted": 1,
                "expectedVersion": conflict.data["participant"]["version"],
            },
            format="json",
            HTTP_ORIGIN="https://evil.example",
        )
        self.assertEqual(rejected_origin.status_code, 403)

        updated = temp_client.put(
            f"/events/temp-access/participant?code={self.event.code}",
            {
                "availabilityInperson": [1, 1],
                "availabilityVirtual": [1, 0],
                "submitted": 1,
                "expectedVersion": conflict.data["participant"]["version"],
            },
            format="json",
            HTTP_ORIGIN="http://testserver",
        )
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(updated.data["participant"]["submitted"], 1)
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 1)

        self.event.status = Event.Status.CLOSED
        self.event.save(update_fields=["status", "updated_at"])
        locked = temp_client.put(
            f"/events/temp-access/participant?code={self.event.code}",
            {
                "availabilityInperson": [0, 0],
                "submitted": 0,
                "expectedVersion": updated.data["participant"]["version"],
            },
            format="json",
            HTTP_ORIGIN="http://testserver",
        )
        self.assertEqual(locked.status_code, 409)
        self.event.status = Event.Status.OPEN
        self.event.save(update_fields=["status", "updated_at"])

        restored = temp_client.get(f"/events/temp-access/session?code={self.event.code}")
        self.assertTrue(restored.data["canViewResults"])
        self.assertIn("results", restored.data)
        self.assertEqual(restored.data["results"]["countedResponseTotal"], 1)

        another = Event.objects.create(
            code="FOREIGN1",
            name="Foreign event",
            organizer=self.organizer,
        )
        foreign_client = APIClient()
        foreign_client.cookies["releviz_temp_event"] = temp_client.cookies[
            "releviz_temp_event"
        ].value
        cross_event = foreign_client.get(f"/events/temp-access/session?code={another.code}")
        self.assertEqual(cross_event.status_code, 401)

        logged_out = temp_client.post(
            "/events/temp-access/logout",
            {},
            format="json",
            HTTP_ORIGIN="http://testserver",
        )
        self.assertEqual(logged_out.status_code, 204)
        session_record.refresh_from_db()
        self.assertIsNotNone(session_record.revoked_at)
        self.assertEqual(
            temp_client.get(f"/events/temp-access/session?code={self.event.code}").status_code,
            401,
        )

    def test_participant_email_and_account_access_remain_organizer_private(self):
        created = self.create_managed()
        managed = Participant.objects.get(member_id=created.data["participant"]["id"])
        managed.availability_inperson = [1, 1]
        managed.availability_virtual = [1, 1]
        managed.submitted = True
        managed.save()

        viewer = create_member("viewer@example.com", "Other", "Participant")
        viewer_client = APIClient()
        viewer_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(viewer)}")
        joined = viewer_client.post(
            f"/events/participants?code={self.event.code}",
            {},
            format="json",
        )
        self.assertEqual(joined.status_code, 201)
        visible = viewer_client.get(f"/events/participants?code={self.event.code}")
        self.assertEqual(visible.status_code, 200)
        self.assertIn(str(managed.member_id), [item["id"] for item in visible.data["participants"]])
        for item in visible.data["participants"]:
            self.assertNotIn("email", item)
            self.assertNotIn("accountAccess", item)
            self.assertNotIn("canOrganizerEditAvailability", item)

        challenge = EmailAuthChallenge.objects.filter(
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS
        )
        self.assertEqual(challenge.count(), 0)
