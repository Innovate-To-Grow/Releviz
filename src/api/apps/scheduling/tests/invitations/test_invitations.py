import uuid
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core import mail
from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.security import RateLimitDecision
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import (
    EmailDeliveryJob,
    EmailDeliveryRequest,
    EmailMessageLog,
)
from apps.mail.services import dispatch_due_email_jobs, dispatch_email_job
from apps.scheduling.models import Event, EventInvitation, Participant
from apps.scheduling.payloads import api_invitation
from apps.scheduling.services.ics import response_deadline_ics
from apps.scheduling.services.invitations import (
    EventEmailRequestError,
    enqueue_manual_reminders,
    invitation_body,
    mark_invitation_for_member,
    mark_invitation_opened,
    resolve_invited_member,
    send_due_event_reminders,
    send_event_reminders,
    split_invitation_emails,
    upsert_and_send_invitations,
)


def request_payload(emails, *, key=None, message=""):
    return {
        "emails": emails,
        "message": message,
        "idempotencyKey": str(key or uuid.uuid4()),
    }


class InvitationServiceTests(TestCase):
    def setUp(self):
        self.organizer = create_member("organizer@example.com", "Org", "Owner")
        self.participant = create_member("participant@example.com", "Part", "Person")
        self.event = Event.objects.create(
            code="ABC123",
            name="Plan; Comma, Back\\slash\nNew",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            response_deadline=timezone.now() + timedelta(hours=23),
            reminder_hours_before=24,
        )

    def test_email_parsing_member_resolution_and_api_shape(self):
        emails, invalid = split_invitation_emails(
            [" Participant@Example.com ", "", "other@example.com", "bad", "other@example.com"]
        )
        self.assertEqual(emails, ["participant@example.com", "other@example.com"])
        self.assertEqual(invalid, ["bad"])
        string_emails, _ = split_invitation_emails("a@example.com; b@example.com\nA@example.com")
        self.assertEqual(string_emails, ["a@example.com", "b@example.com"])
        self.assertEqual(resolve_invited_member("participant@example.com"), self.participant)
        unverified = create_member("unverified@example.com", contact_verified=False)
        self.assertIsNone(resolve_invited_member(unverified.email))

        invitation = EventInvitation.objects.create(
            event=self.event,
            email="upper@example.com",
            member=self.participant,
            invited_by=self.organizer,
            custom_message="Bring notes",
        )
        invitation.last_sent_at = timezone.now()
        invitation.accepted_at = timezone.now()
        invitation.opened_at = timezone.now()
        invitation.joined_at = timezone.now()
        invitation.draft_saved_at = timezone.now()
        invitation.status = EventInvitation.Status.DRAFT_SAVED
        invitation.save()
        data = api_invitation(invitation)
        self.assertEqual(data["email"], "upper@example.com")
        self.assertEqual(data["memberId"], str(self.participant.pk))
        self.assertEqual(data["statusLabel"], "Draft saved")
        self.assertTrue(data["awaitingReminder"])
        self.assertIsNotNone(data["openedAt"])
        self.assertIsNotNone(data["joinedAt"])
        self.assertIsNotNone(data["draftSavedAt"])
        self.assertIsNone(data["submittedAt"])
        self.assertEqual(data["customMessage"], "Bring notes")
        self.assertIn("upper@example.com", str(invitation))

    @override_settings(FRONTEND_URL="https://app.example.com")
    def test_invitation_jobs_are_durable_replay_safe_and_content_addressed(self):
        key = uuid.uuid4()
        result = upsert_and_send_invitations(
            event=self.event,
            emails=["participant@example.com", "manual@example.com"],
            invited_by=self.organizer,
            idempotency_key=key,
            message="Please respond",
        )
        self.assertFalse(result["idempotent"])
        self.assertEqual(result["createdJobCount"], 2)
        self.assertEqual(len(result["invitations"]), 2)
        self.assertEqual(len(mail.outbox), 0)
        ics = response_deadline_ics(self.event)
        self.assertIn("BEGIN:VEVENT", ics.content)
        self.assertIn(
            "SUMMARY:Fill availability for Plan\\; Comma\\, Back\\\\slash\\nNew",
            ics.content,
        )
        self.assertIn("TRIGGER:-PT24H", ics.content)
        self.assertIsNone(response_deadline_ics(Event(code="NODATE", name="No date")))
        self.assertEqual(
            EmailDeliveryJob.objects.filter(status=EmailDeliveryJob.Status.PENDING).count(),
            2,
        )
        request_record = result["request"]
        self.assertIn(str(key), str(request_record))
        self.assertEqual(request_record.jobs.count(), 2)

        dispatch = dispatch_due_email_jobs(limit=10)
        self.assertEqual(dispatch["sent"], 2)
        self.assertEqual(
            {message.to[0] for message in mail.outbox},
            {"manual@example.com", "participant@example.com"},
        )
        participant_email = next(
            message for message in mail.outbox if message.to == ["participant@example.com"]
        )
        self.assertIn("https://app.example.com/event?code=ABC123", participant_email.body)
        participant_invitation = EventInvitation.objects.get(email="participant@example.com")
        self.assertIn(
            f"&invitation={participant_invitation.access_token}",
            participant_email.body,
        )
        invitation_html = participant_email.alternatives[0].content
        self.assertIn("/brand/releviz-logo.png", invitation_html)
        self.assertIn("Share your availability", invitation_html)
        self.assertIn(f"&amp;invitation={participant_invitation.access_token}", invitation_html)
        self.assertIn("Please respond", invitation_html)
        self.assertEqual(
            participant_email.attachments[0][0],
            "releviz-ABC123-availability.ics",
        )
        invitations = list(EventInvitation.objects.order_by("email"))
        self.assertTrue(all(invitation.last_sent_at for invitation in invitations))
        self.assertTrue(all(invitation.first_sent_at for invitation in invitations))
        self.assertIn("Message from organizer", invitation_body(invitations[1]))
        self.assertTrue(EventInvitation.objects.filter(member=self.participant).exists())
        self.assertEqual(
            EmailMessageLog.objects.filter(
                message_type=EmailMessageLog.MessageType.INVITATION,
                status=EmailMessageLog.Status.SENT,
            ).count(),
            2,
        )

        replay = upsert_and_send_invitations(
            event=self.event,
            emails=["participant@example.com", "manual@example.com"],
            invited_by=self.organizer,
            idempotency_key=key,
            message="Please respond",
        )
        self.assertTrue(replay["idempotent"])
        self.assertEqual(replay["createdJobCount"], 2)
        for job in replay["jobs"]:
            self.assertFalse(dispatch_email_job(job.pk)["attempted"])
        self.assertEqual(len(mail.outbox), 2)

        resent = upsert_and_send_invitations(
            event=self.event,
            emails=["manual@example.com", "participant@example.com"],
            invited_by=self.organizer,
            idempotency_key=uuid.uuid4(),
            message="Please respond",
        )
        self.assertFalse(resent["idempotent"])
        self.assertEqual(resent["createdJobCount"], 2)
        self.assertEqual(EmailDeliveryJob.objects.count(), 4)

        changed = upsert_and_send_invitations(
            event=self.event,
            emails=["participant@example.com"],
            invited_by=self.organizer,
            idempotency_key=uuid.uuid4(),
            message="Updated details",
        )
        self.assertEqual(changed["createdJobCount"], 1)
        self.assertEqual(EmailDeliveryJob.objects.count(), 5)

        with self.assertRaisesMessage(EventEmailRequestError, "different invitation details"):
            upsert_and_send_invitations(
                event=self.event,
                emails=["different@example.com"],
                invited_by=self.organizer,
                idempotency_key=key,
                message="Changed",
            )

    def test_sending_preserves_existing_pending_full_member_binding(self):
        pending = create_member(
            "pending-full@example.com",
            "Pending",
            "Full",
            is_active=False,
            contact_verified=False,
        )
        participant = Participant.objects.create(
            event=self.event,
            member=pending,
            participant_name="Pending Full",
        )
        existing_invitation = EventInvitation.objects.create(
            event=self.event,
            email="pending-full@example.com",
            member=pending,
            invited_by=self.organizer,
        )
        self.assertEqual(participant.member_id, pending.pk)
        self.assertEqual(existing_invitation.member_id, pending.pk)
        self.assertIsNone(resolve_invited_member("pending-full@example.com"))

        result = upsert_and_send_invitations(
            event=self.event,
            emails=["pending-full@example.com"],
            invited_by=self.organizer,
            idempotency_key=uuid.uuid4(),
        )

        invitation = result["invitations"][0]
        self.assertEqual(invitation.member_id, pending.pk)
        self.assertEqual(result["jobs"][0].recipient, "pending-full@example.com")

    def test_reminder_jobs_deduplicate_retries_and_new_deadline_cycles(self):
        for email in ["participant@example.com", "manual@example.com"]:
            EventInvitation.objects.create(
                event=self.event,
                email=email,
                invited_by=self.organizer,
                first_sent_at=timezone.now(),
            )

        self.assertEqual(send_event_reminders(self.event, force=False), 2)
        self.assertEqual(len(mail.outbox), 0)
        self.assertEqual(send_event_reminders(self.event, force=True), 0)
        dispatch_due_email_jobs(limit=10)
        self.assertEqual(
            mail.outbox[-1].subject,
            "Reminder: share your availability for Plan; Comma, Back\\slash New",
        )
        reminder_html = mail.outbox[-1].alternatives[0].content
        self.assertIn("Availability reminder", reminder_html)
        self.assertIn("Share your availability", reminder_html)
        self.assertTrue(
            all(
                invitation.reminder_sent_at
                for invitation in EventInvitation.objects.filter(event=self.event)
            )
        )
        self.assertEqual(send_event_reminders(self.event, force=False), 0)
        self.assertEqual(send_event_reminders(self.event, force=True), 0)

        self.event.response_deadline += timedelta(days=1)
        self.event.save(update_fields=["response_deadline", "updated_at"])
        self.assertEqual(send_event_reminders(self.event, force=True), 2)

        self.event.reminders_enabled = False
        self.event.save(update_fields=["reminders_enabled", "updated_at"])
        self.assertEqual(send_event_reminders(self.event, force=True), 0)

        no_deadline = Event.objects.create(
            code="NODEADLINE",
            name="No deadline",
            organizer=self.organizer,
            response_deadline=None,
        )
        EventInvitation.objects.create(
            event=no_deadline,
            email="no-deadline@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        result = enqueue_manual_reminders(
            event=no_deadline,
            requested_by=self.organizer,
            idempotency_key=uuid.uuid4(),
        )
        self.assertEqual(result["createdJobCount"], 1)
        self.assertEqual(result["jobs"][0].attachments, [])

    def test_unsent_managed_invitation_is_not_selected_for_reminders(self):
        invitation = EventInvitation.objects.create(
            event=self.event,
            email="managed-unsent@example.com",
            invited_by=self.organizer,
        )

        self.assertEqual(send_event_reminders(self.event), 0)
        manual = enqueue_manual_reminders(
            event=self.event,
            requested_by=self.organizer,
            idempotency_key=uuid.uuid4(),
        )
        self.assertEqual(manual["request"].recipient_count, 0)
        self.assertEqual(manual["createdJobCount"], 0)
        self.assertFalse(EmailDeliveryJob.objects.filter(invitation=invitation).exists())

        invitation.first_sent_at = timezone.now()
        invitation.last_sent_at = invitation.first_sent_at
        invitation.save(update_fields=["first_sent_at", "last_sent_at", "updated_at"])
        self.assertEqual(send_event_reminders(self.event), 1)

    def test_service_authorization_caps_and_lifecycle_are_enforced(self):
        other = create_member("other@example.com")
        with self.assertRaisesMessage(EventEmailRequestError, "Only the organizer"):
            upsert_and_send_invitations(
                event=self.event,
                emails=["new@example.com"],
                invited_by=other,
                idempotency_key=uuid.uuid4(),
            )
        with self.assertRaisesMessage(EventEmailRequestError, "Only the organizer"):
            enqueue_manual_reminders(
                event=self.event,
                requested_by=other,
                idempotency_key=uuid.uuid4(),
            )

        EventInvitation.objects.create(
            event=self.event,
            email="existing@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        with override_settings(INVITATION_MAX_EVENT_RECIPIENTS=1):
            with self.assertRaisesMessage(EventEmailRequestError, "at most 1"):
                upsert_and_send_invitations(
                    event=self.event,
                    emails=["new@example.com"],
                    invited_by=self.organizer,
                    idempotency_key=uuid.uuid4(),
                )

        EventInvitation.objects.create(
            event=self.event,
            email="second@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        with override_settings(REMINDER_MAX_RECIPIENTS=1):
            with self.assertRaisesMessage(EventEmailRequestError, "at most 1"):
                enqueue_manual_reminders(
                    event=self.event,
                    requested_by=self.organizer,
                    idempotency_key=uuid.uuid4(),
                )

        self.event.status = Event.Status.FINALIZED
        self.event.save(update_fields=["status", "updated_at"])
        with self.assertRaisesMessage(EventEmailRequestError, "cannot change"):
            upsert_and_send_invitations(
                event=self.event,
                emails=["locked@example.com"],
                invited_by=self.organizer,
                idempotency_key=uuid.uuid4(),
            )
        with self.assertRaisesMessage(EventEmailRequestError, "cannot change"):
            enqueue_manual_reminders(
                event=self.event,
                requested_by=self.organizer,
                idempotency_key=uuid.uuid4(),
            )

    def test_due_reminder_command_and_member_status_updates(self):
        invitation = EventInvitation.objects.create(
            event=self.event,
            email="participant@example.com",
            member=self.participant,
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        later = Event.objects.create(
            code="LATER",
            name="Later",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            response_deadline=timezone.now() + timedelta(days=4),
            reminder_hours_before=1,
        )
        EventInvitation.objects.create(
            event=later,
            email="later@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )

        self.assertEqual(send_due_event_reminders(window_minutes=20), 1)
        invitation.refresh_from_db()
        self.assertIsNone(invitation.reminder_sent_at)
        self.assertEqual(dispatch_due_email_jobs(limit=10)["sent"], 1)
        invitation.refresh_from_db()
        self.assertIsNotNone(invitation.reminder_sent_at)

        mark_invitation_for_member(event=self.event, member=self.participant)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.JOINED)
        self.assertIsNotNone(invitation.accepted_at)
        self.assertIsNotNone(invitation.joined_at)
        mark_invitation_for_member(
            event=self.event,
            member=self.participant,
            draft_saved=True,
        )
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.DRAFT_SAVED)
        self.assertIsNotNone(invitation.draft_saved_at)
        mark_invitation_for_member(event=self.event, member=self.participant, submitted=True)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.SUBMITTED)
        self.assertIsNotNone(invitation.submitted_at)
        submitted_at = invitation.submitted_at
        mark_invitation_for_member(event=self.event, member=self.participant, submitted=True)
        invitation.refresh_from_db()
        self.assertEqual(invitation.submitted_at, submitted_at)

        no_email = create_member("no-email@example.com")
        ContactEmail.objects.filter(member=no_email).delete()
        no_email.email = ""
        mark_invitation_for_member(event=self.event, member=no_email)

        output = StringIO()
        call_command("send_due_event_reminders", "--window-minutes=20", stdout=output)
        self.assertIn("Queued 0 new reminder email job(s).", output.getvalue())
        with self.assertRaises(CommandError):
            call_command("send_due_event_reminders", "--window-minutes=0")

    def test_invitation_open_tracking_is_private_idempotent_and_does_not_downgrade(self):
        invitation = EventInvitation.objects.create(
            event=self.event,
            email=self.participant.email,
            invited_by=self.organizer,
        )
        self.assertFalse(
            mark_invitation_opened(
                event_code="WRONG",
                access_token=invitation.access_token,
            )
        )
        self.assertTrue(
            mark_invitation_opened(
                event_code=self.event.code,
                access_token=invitation.access_token,
            )
        )
        invitation.refresh_from_db()
        opened_at = invitation.opened_at
        self.assertEqual(invitation.status, EventInvitation.Status.OPENED)
        self.assertIsNotNone(opened_at)

        self.assertTrue(
            mark_invitation_opened(
                event_code=self.event.code,
                access_token=invitation.access_token,
            )
        )
        invitation.refresh_from_db()
        self.assertEqual(invitation.opened_at, opened_at)

        mark_invitation_for_member(event=self.event, member=self.participant)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.JOINED)
        mark_invitation_opened(
            event_code=self.event.code,
            access_token=invitation.access_token,
        )
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.JOINED)


class InvitationApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("organizer@example.com", "Org", "Owner")
        self.participant = create_member("participant@example.com", "Part", "Person")
        self.event = Event.objects.create(
            code="EVT123",
            name="Planning",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            response_deadline=timezone.now() + timedelta(hours=24),
            status=Event.Status.ACTIVE,
            access_mode="open_link",
        )

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def invitation_url(self):
        return f"/events/invitations?code={self.event.code}"

    def reminder_url(self):
        return f"/events/reminders?code={self.event.code}"

    def test_public_open_tracking_is_non_enumerating_and_organizer_visible(self):
        invitation = EventInvitation.objects.create(
            event=self.event,
            email="opened@example.com",
            invited_by=self.organizer,
            last_sent_at=timezone.now(),
        )
        for payload in [
            {},
            {"code": self.event.code, "token": "not-a-uuid"},
            {"code": "WRONG", "token": str(invitation.access_token)},
        ]:
            response = self.client.post(
                "/events/invitations/open",
                payload,
                format="json",
            )
            self.assertEqual(response.status_code, 204)
            self.assertIn("no-store", response["Cache-Control"])
        invitation.refresh_from_db()
        self.assertIsNone(invitation.opened_at)

        opened = self.client.post(
            "/events/invitations/open",
            {
                "code": self.event.code,
                "token": str(invitation.access_token),
            },
            format="json",
        )
        self.assertEqual(opened.status_code, 204)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.OPENED)
        self.assertIsNotNone(invitation.opened_at)

        self.authenticate(self.organizer)
        listed = self.client.get(self.invitation_url())
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(
            listed.data["invitations"][0],
            {
                "id": invitation.pk,
                "email": "opened@example.com",
                "memberId": None,
                "status": "opened",
                "statusLabel": "Opened",
                "firstSentAt": None,
                "lastSentAt": invitation.last_sent_at.isoformat(),
                "reminderSentAt": None,
                "acceptedAt": None,
                "openedAt": invitation.opened_at.isoformat(),
                "joinedAt": None,
                "draftSavedAt": None,
                "submittedAt": None,
                "awaitingReminder": True,
                "customMessage": "",
            },
        )

    def test_event_creation_includes_deadline_and_validates_reminders(self):
        self.authenticate(self.organizer)
        future_deadline = timezone.now() + timedelta(days=2)
        response = self.client.post(
            "/events",
            {
                "name": "Timed",
                "responseDeadline": future_deadline.isoformat(),
                "remindersEnabled": False,
                "reminderHoursBefore": "12",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["event"]["reminderHoursBefore"], 12)
        self.assertFalse(response.data["event"]["remindersEnabled"])
        self.assertIsNotNone(response.data["event"]["responseDeadline"])

        aware = self.client.post(
            "/events",
            {
                "name": "Aware deadline",
                "responseDeadline": (timezone.now() + timedelta(days=3)).isoformat(),
            },
            format="json",
        )
        self.assertEqual(aware.status_code, 201)

        invalid_payloads = [
            ({"name": "Bad", "responseDeadline": "not-date"}, "responseDeadline"),
            ({"name": "Bad", "remindersEnabled": "yes"}, "remindersEnabled"),
            ({"name": "Bad", "reminderHoursBefore": "soon"}, "reminderHoursBefore"),
            ({"name": "Bad", "reminderHoursBefore": 721}, "between 0 and 720"),
        ]
        for payload, message in invalid_payloads:
            with self.subTest(message=message):
                response = self.client.post("/events", payload, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertIn(message, response.data["error"])

    def test_invitation_api_validation_replay_and_durable_provider_failure(self):
        self.authenticate(self.participant)
        forbidden = self.client.get(self.invitation_url())
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(self.client.get("/events/invitations").status_code, 400)
        self.assertEqual(self.client.get("/events/invitations?code=NOPE").status_code, 404)

        self.authenticate(self.organizer)
        self.assertEqual(
            self.client.post(
                "/events/invitations",
                request_payload(["a@example.com"]),
                format="json",
            ).status_code,
            400,
        )
        missing_key = self.client.post(
            self.invitation_url(),
            {"emails": ["a@example.com"]},
            format="json",
        )
        self.assertEqual(missing_key.status_code, 400)
        self.assertIn("idempotencyKey", missing_key.data["error"])
        invalid = self.client.post(
            self.invitation_url(),
            request_payload(["bad"]),
            format="json",
        )
        self.assertEqual(invalid.status_code, 400)
        empty = self.client.post(
            self.invitation_url(),
            request_payload([]),
            format="json",
        )
        self.assertEqual(empty.status_code, 400)
        too_long = self.client.post(
            self.invitation_url(),
            request_payload(["a@example.com"], message="x" * 1001),
            format="json",
        )
        self.assertEqual(too_long.status_code, 400)
        with override_settings(INVITATION_MAX_BATCH_SIZE=1):
            too_many = self.client.post(
                self.invitation_url(),
                request_payload(["a@example.com", "b@example.com"]),
                format="json",
            )
        self.assertEqual(too_many.status_code, 400)
        self.assertIn("at most 1", too_many.data["error"])

        key = uuid.uuid4()
        payload = request_payload(
            ["participant@example.com", "manual@example.com"],
            key=key,
            message="Join",
        )
        sent = self.client.post(self.invitation_url(), payload, format="json")
        self.assertEqual(sent.status_code, 202)
        self.assertFalse(sent.data["idempotent"])
        self.assertEqual(sent.data["delivery"]["pending"], 2)
        self.assertEqual(sent.data["delivery"]["sent"], 0)
        self.assertEqual(sent.data["enqueued"], 2)
        self.assertEqual(sent.data["deduplicated"], 0)
        self.assertEqual(len(sent.data["invitations"]), 2)
        self.assertEqual(
            EventInvitation.objects.get(email="participant@example.com").member,
            self.participant,
        )
        listed = self.client.get(self.invitation_url())
        self.assertEqual(len(listed.data["invitations"]), 2)

        replay = self.client.post(self.invitation_url(), payload, format="json")
        self.assertEqual(replay.status_code, 202)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(EmailDeliveryJob.objects.count(), 2)
        self.assertEqual(len(mail.outbox), 0)

        conflict = self.client.post(
            self.invitation_url(),
            request_payload(["different@example.com"], key=key),
            format="json",
        )
        self.assertEqual(conflict.status_code, 409)

        resent = self.client.post(
            self.invitation_url(),
            request_payload(
                ["manual@example.com", "participant@example.com"],
                message="Join",
            ),
            format="json",
        )
        self.assertEqual(resent.status_code, 202)
        self.assertEqual(resent.data["enqueued"], 2)
        self.assertEqual(resent.data["deduplicated"], 0)
        self.assertEqual(len(mail.outbox), 0)

        failed = self.client.post(
            self.invitation_url(),
            request_payload(["again@example.com"]),
            format="json",
        )
        self.assertEqual(failed.status_code, 202)
        self.assertEqual(failed.data["delivery"]["pending"], 1)
        retry_job = EmailDeliveryJob.objects.get(recipient="again@example.com")
        self.assertEqual(retry_job.status, EmailDeliveryJob.Status.PENDING)
        with patch(
            "apps.mail.services.EmailMultiAlternatives.send",
            side_effect=TimeoutError("provider timeout"),
        ):
            dispatch_email_job(retry_job.pk)
        retry_job.refresh_from_db()
        self.assertEqual(retry_job.status, EmailDeliveryJob.Status.RETRY)
        self.assertIsNone(EventInvitation.objects.get(email="again@example.com").last_sent_at)

        retry_job.next_attempt_at = timezone.now()
        retry_job.save(update_fields=["next_attempt_at", "updated_at"])
        self.assertEqual(
            dispatch_email_job(retry_job.pk)["status"],
            EmailDeliveryJob.Status.SENT,
        )
        self.assertIsNotNone(EventInvitation.objects.get(email="again@example.com").last_sent_at)

    def test_join_submit_and_reminder_api_replay_and_failure(self):
        EventInvitation.objects.create(
            event=self.event,
            email="participant@example.com",
            member=self.participant,
            invited_by=self.organizer,
        )
        self.authenticate(self.participant)
        join = self.client.post(
            f"/events/participants?code={self.event.code}",
            {},
            format="json",
        )
        self.assertEqual(join.status_code, 201)
        invitation = EventInvitation.objects.get(email="participant@example.com")
        self.assertEqual(invitation.status, EventInvitation.Status.JOINED)

        draft = self.client.put(
            f"/events/participants/update?code={self.event.code}"
            f"&participantId={self.participant.pk}",
            {
                "availabilityInperson": [1, 0],
                "submitted": 0,
                "expectedVersion": join.data["participant"]["version"],
            },
            format="json",
        )
        self.assertEqual(draft.status_code, 200)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.DRAFT_SAVED)

        repeated_draft = self.client.put(
            f"/events/participants/update?code={self.event.code}"
            f"&participantId={self.participant.pk}",
            {
                "availabilityInperson": [1, 0],
                "submitted": 0,
                "expectedVersion": draft.data["participant"]["version"],
            },
            format="json",
        )
        self.assertEqual(repeated_draft.status_code, 200)
        self.assertEqual(
            repeated_draft.data["participant"]["version"],
            draft.data["participant"]["version"],
        )

        update = self.client.put(
            f"/events/participants/update?code={self.event.code}"
            f"&participantId={self.participant.pk}",
            {
                "submitted": 1,
                "expectedVersion": draft.data["participant"]["version"],
            },
            format="json",
        )
        self.assertEqual(update.status_code, 200)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.SUBMITTED)
        self.assertTrue(
            Participant.objects.get(member=self.participant, event=self.event).submitted
        )
        unchanged_submitted_schedule = self.client.put(
            f"/events/participants/update?code={self.event.code}"
            f"&participantId={self.participant.pk}",
            {
                "availabilityInperson": [1, 0],
                "expectedVersion": update.data["participant"]["version"],
            },
            format="json",
        )
        self.assertEqual(unchanged_submitted_schedule.status_code, 200)

        self.authenticate(self.organizer)
        unchanged_group = self.client.put(
            f"/events/participants/update?code={self.event.code}"
            f"&participantId={self.participant.pk}",
            {"groupName": None},
            format="json",
        )
        self.assertEqual(unchanged_group.status_code, 200)

        key = uuid.uuid4()
        self.authenticate(self.participant)
        self.assertEqual(
            self.client.post(
                self.reminder_url(),
                {"idempotencyKey": str(key)},
                format="json",
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/events/reminders",
                {"idempotencyKey": str(key)},
                format="json",
            ).status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/events/reminders?code=NOPE",
                {"idempotencyKey": str(key)},
                format="json",
            ).status_code,
            404,
        )

        self.authenticate(self.organizer)
        missing_key = self.client.post(self.reminder_url(), {}, format="json")
        self.assertEqual(missing_key.status_code, 400)
        reminder = self.client.post(
            self.reminder_url(),
            {"idempotencyKey": str(key)},
            format="json",
        )
        self.assertEqual(reminder.status_code, 202)
        self.assertEqual(reminder.data["sent"], 0)
        self.assertEqual(reminder.data["recipientCount"], 0)

        pending = EventInvitation.objects.create(
            event=self.event,
            email="pending@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        second_key = uuid.uuid4()
        reminder = self.client.post(
            self.reminder_url(),
            {"idempotencyKey": str(second_key)},
            format="json",
        )
        self.assertEqual(reminder.status_code, 202)
        self.assertEqual(reminder.data["sent"], 0)
        self.assertEqual(reminder.data["delivery"]["pending"], 1)
        self.assertEqual(reminder.data["enqueued"], 1)
        pending.refresh_from_db()
        self.assertIsNone(pending.reminder_sent_at)

        replay = self.client.post(
            self.reminder_url(),
            {"idempotencyKey": str(second_key)},
            format="json",
        )
        self.assertEqual(replay.status_code, 202)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(len(mail.outbox), 0)

        deduplicated = self.client.post(
            self.reminder_url(),
            {"idempotencyKey": str(uuid.uuid4())},
            format="json",
        )
        self.assertEqual(deduplicated.data["enqueued"], 0)
        self.assertEqual(deduplicated.data["deduplicated"], 1)
        self.assertEqual(len(mail.outbox), 0)

        failed_invitation = EventInvitation.objects.create(
            event=self.event,
            email="failed@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        failed = self.client.post(
            self.reminder_url(),
            {"idempotencyKey": str(uuid.uuid4())},
            format="json",
        )
        self.assertEqual(failed.status_code, 202)
        self.assertEqual(failed.data["delivery"]["pending"], 2)
        failed_job = EmailDeliveryJob.objects.filter(
            recipient="failed@example.com",
            message_type=EmailMessageLog.MessageType.REMINDER,
        ).get()
        with patch(
            "apps.mail.services.EmailMultiAlternatives.send",
            side_effect=TimeoutError("provider timeout"),
        ):
            dispatch_email_job(failed_job.pk)
        failed_job.refresh_from_db()
        self.assertEqual(failed_job.status, EmailDeliveryJob.Status.RETRY)
        failed_invitation.refresh_from_db()
        self.assertIsNone(failed_invitation.reminder_sent_at)

        self.event.response_deadline += timedelta(days=1)
        self.event.save(update_fields=["response_deadline", "updated_at"])
        conflict = self.client.post(
            self.reminder_url(),
            {"idempotencyKey": str(second_key)},
            format="json",
        )
        self.assertEqual(conflict.status_code, 409)

    def test_invitation_and_reminder_bulk_and_rate_controls(self):
        self.authenticate(self.organizer)

        EventInvitation.objects.create(
            event=self.event,
            email="existing@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        with override_settings(INVITATION_MAX_EVENT_RECIPIENTS=1):
            capped = self.client.post(
                self.invitation_url(),
                request_payload(["new@example.com"]),
                format="json",
            )
        self.assertEqual(capped.status_code, 400)

        EventInvitation.objects.create(
            event=self.event,
            email="second@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        with override_settings(REMINDER_MAX_RECIPIENTS=1):
            capped = self.client.post(
                self.reminder_url(),
                {"idempotencyKey": str(uuid.uuid4())},
                format="json",
            )
        self.assertEqual(capped.status_code, 400)

        denied = RateLimitDecision(allowed=False, retry_after=30)
        with patch(
            "apps.scheduling.views.invitations.collection.consume_request_rate_limit",
            return_value=denied,
        ):
            limited = self.client.post(
                self.invitation_url(),
                request_payload(["one@example.com", "two@example.com"]),
                format="json",
            )
        self.assertEqual(limited.status_code, 429)

        with patch(
            "apps.scheduling.views.invitations.reminders.consume_request_rate_limit",
            return_value=denied,
        ):
            limited = self.client.post(
                self.reminder_url(),
                {"idempotencyKey": str(uuid.uuid4())},
                format="json",
            )
        self.assertEqual(limited.status_code, 429)

        with patch(
            "apps.scheduling.views.invitations.collection.consume_request_rate_limit",
            side_effect=[RateLimitDecision(), denied],
        ):
            first = self.client.post(
                self.invitation_url(),
                request_payload(["allowed@example.com"]),
                format="json",
            )
            blocked = self.client.post(
                self.invitation_url(),
                request_payload(["blocked@example.com"]),
                format="json",
            )
        self.assertEqual(first.status_code, 202)
        self.assertEqual(blocked.status_code, 429)

    def test_disabled_reminders_create_an_auditable_empty_request(self):
        self.event.reminders_enabled = False
        self.event.save(update_fields=["reminders_enabled", "updated_at"])
        self.authenticate(self.organizer)
        response = self.client.post(
            self.reminder_url(),
            {"idempotencyKey": str(uuid.uuid4())},
            format="json",
        )
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.data["recipientCount"], 0)
        request_record = EmailDeliveryRequest.objects.get()
        self.assertEqual(request_record.recipient_count, 0)
        self.assertEqual(request_record.created_job_count, 0)
