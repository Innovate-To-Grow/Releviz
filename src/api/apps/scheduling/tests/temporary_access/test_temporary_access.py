import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core import mail
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest
from apps.mail.services import dispatch_due_email_jobs, dispatch_email_job
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    TemporaryEventSession,
)
from apps.scheduling.services.results.snapshots import recompute_event_results


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
            status=Event.Status.ACTIVE,
            access_mode="open_link",
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            participant_view_permission="realtime",
        )

    def create_managed(
        self,
        *,
        name="Managed Person",
        email="managed@example.com",
        key=None,
        send_invitation=None,
    ):
        payload = {"name": name, "email": email, "idempotencyKey": str(key or uuid.uuid4())}
        if send_invitation is not None:
            payload["sendInvitation"] = send_invitation
        return self.organizer_client.post(
            f"/events/participants/managed?code={self.event.code}",
            payload,
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
        verification_code = "123456"
        with (
            patch(
                "apps.authn.services.email.challenges._random_code",
                return_value=verification_code,
            ),
            patch(
                "apps.authn.services.email.send_email.send_verification_email"
            ) as send_verification,
            self.captureOnCommitCallbacks(execute=True),
        ):
            requested = client.post(
                "/events/temp-access/request-code",
                {
                    "code": self.event.code,
                    "invitationToken": str(invitation.access_token),
                },
                format="json",
            )
        self.assertEqual(requested.status_code, 202)
        send_verification.assert_called_once()
        verified = client.post(
            "/events/temp-access/verify",
            {
                "code": self.event.code,
                "invitationToken": str(invitation.access_token),
                "verificationCode": verification_code,
            },
            format="json",
        )
        self.assertEqual(verified.status_code, 200, verified.data)
        return client, verified

    def test_managed_creation_reuses_global_identity_and_queues_one_invitation(self):
        created = self.create_managed()
        self.assertEqual(created.status_code, 201, created.data)
        participant_id = created.data["participant"]["id"]
        self.assertEqual(created.data["participant"]["accountAccess"], "temporary")
        self.assertEqual(created.data["participant"]["email"], "managed@example.com")
        self.assertEqual(created.data["autoInvitedCount"], 1)
        self.assertTrue(created.data["participant"]["canOrganizerEditAvailability"])

        member = get_user_model().objects.get(pk=participant_id)
        self.assertEqual(member.access_level, member.AccessLevel.TEMPORARY)
        self.assertTrue(member.is_active)
        self.assertFalse(member.has_usable_password())
        self.assertFalse(ContactEmail.objects.get(member=member).verified)
        invitation = EventInvitation.objects.get(event=self.event, member=member)
        self.assertIsNone(invitation.first_sent_at)
        self.assertEqual(EmailDeliveryJob.objects.count(), 1)
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
            {
                "name": "Another display name",
                "email": "managed@example.com",
                "idempotencyKey": str(uuid.uuid4()),
            },
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

    def test_managed_add_only_creates_the_person_without_queueing_an_invitation(self):
        key = uuid.uuid4()
        created = self.create_managed(key=key, send_invitation=False)
        self.assertEqual(created.status_code, 201, created.data)
        participant_id = created.data["participant"]["id"]
        self.assertTrue(created.data["created"])
        self.assertFalse(created.data["restored"])
        self.assertTrue(created.data["memberCreated"])
        self.assertFalse(created.data["idempotent"])
        self.assertIsNone(created.data["deliveryRequest"])
        self.assertEqual(created.data["autoInvitedCount"], 0)
        self.assertEqual(created.data["participant"]["accountAccess"], "temporary")
        self.assertEqual(created.data["participant"]["email"], "managed@example.com")
        self.assertEqual(created.data["participant"]["invitationStatus"], "not_sent")
        self.assertTrue(created.data["participant"]["canOrganizerEditAvailability"])

        member = get_user_model().objects.get(pk=participant_id)
        self.assertEqual(member.access_level, member.AccessLevel.TEMPORARY)
        self.assertFalse(ContactEmail.objects.get(member=member).verified)
        invitation = EventInvitation.objects.get(event=self.event, member=member)
        self.assertIsNone(invitation.first_sent_at)
        self.assertIsNone(invitation.last_sent_at)
        self.assertEqual(invitation.status, EventInvitation.Status.INVITED)
        self.assertFalse(EmailDeliveryJob.objects.exists())
        self.assertFalse(EmailDeliveryRequest.objects.exists())
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 2)

        roster = self.organizer_client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(roster.status_code, 200, roster.data)
        self.assertEqual(roster.data["participants"][0]["memberId"], participant_id)
        self.assertEqual(roster.data["participants"][0]["invitationStatus"], "not_sent")
        self.assertIsNone(roster.data["latestDeliveryRequest"])
        listed = self.organizer_client.get(f"/events/participants?code={self.event.code}")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.data["participants"][0]["invitationStatus"], "not_sent")

        self.assertEqual(dispatch_due_email_jobs(limit=10)["sent"], 0)
        self.assertEqual(len(mail.outbox), 0)

        replay = self.create_managed(key=key, send_invitation=False)
        self.assertEqual(replay.status_code, 200, replay.data)
        self.assertFalse(replay.data["created"])
        self.assertFalse(replay.data["restored"])
        self.assertFalse(replay.data["idempotent"])
        self.assertIsNone(replay.data["deliveryRequest"])
        self.assertEqual(replay.data["autoInvitedCount"], 0)
        self.assertEqual(replay.data["participant"]["id"], participant_id)
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 1)
        self.assertFalse(EmailDeliveryJob.objects.exists())
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 2)

        for value in ["false", 0, 1]:
            with self.subTest(value=value):
                invalid = self.create_managed(email="flag@example.com", send_invitation=value)
                self.assertEqual(invalid.status_code, 400, invalid.data)
                self.assertEqual(invalid.data["error"], "sendInvitation must be a boolean")
        self.assertFalse(Participant.objects.filter(member__email="flag@example.com").exists())

        full = self.create_managed(
            name="Organizer label",
            email="full@example.com",
            send_invitation=False,
        )
        self.assertEqual(full.status_code, 201, full.data)
        self.assertEqual(full.data["participant"]["id"], str(self.full_member.pk))
        self.assertFalse(full.data["memberCreated"])
        self.assertEqual(full.data["participant"]["accountAccess"], "full")
        self.assertFalse(full.data["participant"]["canOrganizerEditAvailability"])
        self.assertEqual(full.data["participant"]["invitationStatus"], "not_sent")
        self.assertIsNone(full.data["deliveryRequest"])
        self.assertEqual(full.data["autoInvitedCount"], 0)
        self.assertIsNone(
            EventInvitation.objects.get(event=self.event, member=self.full_member).first_sent_at
        )
        self.assertFalse(EmailDeliveryJob.objects.exists())
        self.assertFalse(EmailDeliveryRequest.objects.exists())

        sent = self.create_managed(name="Invited Person", email="invited@example.com")
        self.assertEqual(sent.status_code, 201, sent.data)
        self.assertEqual(sent.data["autoInvitedCount"], 1)
        self.assertEqual(sent.data["participant"]["invitationStatus"], "not_sent")
        self.assertEqual(EmailDeliveryJob.objects.count(), 1)
        self.assertEqual(dispatch_due_email_jobs(limit=10)["sent"], 1)
        self.assertEqual([message.to for message in mail.outbox], [["invited@example.com"]])
        statuses = {
            item["email"]: item["invitationStatus"]
            for item in self.organizer_client.get(f"/events/roster?code={self.event.code}").data[
                "participants"
            ]
        }
        self.assertEqual(
            statuses,
            {
                "managed@example.com": "not_sent",
                "full@example.com": "not_sent",
                "invited@example.com": "sent",
            },
        )

    def test_temporary_and_full_members_receive_the_correct_manual_links_and_resends(self):
        self.event.response_deadline = timezone.now() + timedelta(days=1)
        self.event.save(update_fields=["response_deadline", "updated_at"])
        self.create_managed()
        self.create_managed(name="Full Member", email="full@example.com")
        first = self.send_invitation()
        self.assertEqual(first.status_code, 202, first.data)
        self.assertEqual(first.data["enqueued"], 1)
        self.assertEqual(first.data["delivery"]["pending"], 1)
        self.assertEqual(len(mail.outbox), 0)
        managed_job = EmailDeliveryJob.objects.filter(recipient="managed@example.com").first()
        dispatch_email_job(managed_job.pk)
        self.assertIn("/temp-access?code=TEMP123", mail.outbox[-1].body)
        self.assertIn("six-digit code", mail.outbox[-1].body)
        self.assertIn("/temp-access?code=TEMP123", mail.outbox[-1].attachments[0][1])

        full = self.send_invitation("full@example.com")
        self.assertEqual(full.status_code, 202)
        full_job = EmailDeliveryJob.objects.filter(recipient="full@example.com").first()
        dispatch_email_job(full_job.pk)
        self.assertIn("/event?code=TEMP123", mail.outbox[-1].body)
        self.assertNotIn("/temp-access", mail.outbox[-1].body)

        resent = self.send_invitation()
        self.assertEqual(resent.status_code, 202)
        self.assertEqual(resent.data["enqueued"], 1)
        self.assertEqual(
            EmailDeliveryJob.objects.filter(recipient="managed@example.com").count(),
            3,
        )

    def test_cross_event_temp_invitation_requires_create_person_and_is_atomic(self):
        self.create_managed()
        other_event = Event.objects.create(
            code="OTHER456",
            name="Other organizer event",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            access_mode="open_link",
            opened_at=timezone.now(),
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
        dispatch_email_job(EmailDeliveryJob.objects.get(recipient="managed@example.com").pk)
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
        self.event.status = Event.Status.ACTIVE
        self.event.save(update_fields=["status", "updated_at"])

        recompute_event_results(self.event.pk)
        restored = temp_client.get(f"/events/temp-access/session?code={self.event.code}")
        # Even on a "realtime" event a temporary participant never receives
        # group availability.
        self.assertFalse(restored.data["canViewResults"])
        self.assertNotIn("results", restored.data)
        self.assertNotIn("resultSnapshot", restored.data)

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
        self.assertEqual(
            [item["id"] for item in visible.data["participants"]],
            [str(viewer.pk)],
        )
        for item in visible.data["participants"]:
            self.assertNotIn("email", item)
            self.assertNotIn("accountAccess", item)
            self.assertNotIn("canOrganizerEditAvailability", item)

        challenge = EmailAuthChallenge.objects.filter(
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS
        )
        self.assertEqual(challenge.count(), 0)
