from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core import mail
from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.tests.helpers import create_member, token_for
from apps.messaging.models import EmailMessageLog
from apps.messaging.services import EmailDeliveryError
from apps.scheduling.models import Event, EventInvitation, Participant
from apps.scheduling.services import (
    api_invitation,
    invitation_body,
    mark_invitation_for_member,
    resolve_invited_member,
    response_deadline_ics,
    send_due_event_reminders,
    send_event_reminders,
    split_invitation_emails,
    upsert_and_send_invitations,
)


class InvitationServiceTests(TestCase):
    def setUp(self):
        self.organizer = create_member("organizer@example.com", "Org", "Owner")
        self.participant = create_member("participant@example.com", "Part", "Person")
        self.event = Event.objects.create(
            code="ABC123",
            name="Plan; Comma, Back\\slash\nNew",
            organizer=self.organizer,
            days=[1],
            start_hour=9,
            end_hour=10,
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
        invitation.reminder_sent_at = timezone.now()
        invitation.accepted_at = timezone.now()
        invitation.save()
        data = api_invitation(invitation)
        self.assertEqual(data["email"], "upper@example.com")
        self.assertEqual(data["memberId"], str(self.participant.pk))
        self.assertEqual(data["customMessage"], "Bring notes")
        self.assertIn("upper@example.com", str(invitation))

    @override_settings(FRONTEND_URL="https://app.example.com")
    def test_invitation_email_reminders_and_ics(self):
        invitations = upsert_and_send_invitations(
            event=self.event,
            emails=["participant@example.com", "manual@example.com"],
            invited_by=self.organizer,
            message="Please respond",
        )
        self.assertEqual(len(invitations), 2)
        self.assertEqual(mail.outbox[0].to, ["participant@example.com"])
        self.assertIn("https://app.example.com/event?code=ABC123", mail.outbox[0].body)
        self.assertEqual(mail.outbox[0].attachments[0][0], "releviz-ABC123-availability.ics")
        ics = response_deadline_ics(self.event)
        self.assertIn("BEGIN:VEVENT", ics.content)
        self.assertIn(
            "SUMMARY:Fill availability for Plan\\; Comma\\, Back\\\\slash\\nNew",
            ics.content,
        )
        self.assertIn("TRIGGER:-PT24H", ics.content)
        self.assertIsNone(response_deadline_ics(Event(code="NODATE", name="No date")))
        self.assertIn("Message from organizer", invitation_body(invitations[0]))
        self.assertTrue(EventInvitation.objects.filter(member=self.participant).exists())
        self.assertEqual(
            EmailMessageLog.objects.filter(
                message_type=EmailMessageLog.MessageType.INVITATION
            ).count(),
            2,
        )

        sent = send_event_reminders(self.event, force=False)
        self.assertEqual(sent, 2)
        self.assertEqual(
            mail.outbox[-1].subject,
            "Reminder: share your availability for Plan; Comma, Back\\slash New",
        )
        self.assertEqual(send_event_reminders(self.event, force=False), 0)
        self.assertEqual(send_event_reminders(self.event, force=True), 2)

        self.event.reminders_enabled = False
        self.event.save(update_fields=["reminders_enabled", "updated_at"])
        self.assertEqual(send_event_reminders(self.event, force=True), 0)

    def test_due_reminder_command_and_member_status_updates(self):
        invitation = EventInvitation.objects.create(
            event=self.event,
            email="participant@example.com",
            member=self.participant,
            invited_by=self.organizer,
        )
        later = Event.objects.create(
            code="LATER",
            name="Later",
            organizer=self.organizer,
            days=[1],
            start_hour=9,
            end_hour=10,
            response_deadline=timezone.now() + timedelta(days=4),
            reminder_hours_before=1,
        )
        EventInvitation.objects.create(
            event=later,
            email="later@example.com",
            invited_by=self.organizer,
        )

        self.assertEqual(send_due_event_reminders(window_minutes=20), 1)
        invitation.refresh_from_db()
        self.assertIsNotNone(invitation.reminder_sent_at)

        mark_invitation_for_member(event=self.event, member=self.participant)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.ACCEPTED)
        self.assertIsNotNone(invitation.accepted_at)
        mark_invitation_for_member(event=self.event, member=self.participant, submitted=True)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.SUBMITTED)

        no_email = create_member("no-email@example.com")
        ContactEmail.objects.filter(member=no_email).delete()
        no_email.email = ""
        mark_invitation_for_member(event=self.event, member=no_email)

        output = StringIO()
        call_command("send_due_event_reminders", "--window-minutes=20", stdout=output)
        self.assertIn("Sent 0 reminder email(s).", output.getvalue())
        with self.assertRaises(CommandError):
            call_command("send_due_event_reminders", "--window-minutes=0")


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
            start_hour=9,
            end_hour=10,
            response_deadline=timezone.now() + timedelta(hours=24),
        )

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def test_event_creation_includes_deadline_and_validates_reminders(self):
        self.authenticate(self.organizer)
        response = self.client.post(
            "/api/events",
            {
                "name": "Timed",
                "responseDeadline": "2026-07-08T12:00:00",
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
            "/api/events",
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
                response = self.client.post("/api/events", payload, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertIn(message, response.data["error"])

    def test_invitation_api_permissions_validation_and_delivery_error(self):
        self.authenticate(self.participant)
        forbidden = self.client.get(f"/api/events/invitations?code={self.event.code}")
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(self.client.get("/api/events/invitations").status_code, 400)
        self.assertEqual(self.client.get("/api/events/invitations?code=NOPE").status_code, 404)

        self.authenticate(self.organizer)
        self.assertEqual(
            self.client.post(
                "/api/events/invitations",
                {"emails": ["a@example.com"]},
                format="json",
            ).status_code,
            400,
        )
        invalid = self.client.post(
            f"/api/events/invitations?code={self.event.code}",
            {"emails": ["bad"]},
            format="json",
        )
        self.assertEqual(invalid.status_code, 400)
        empty = self.client.post(
            f"/api/events/invitations?code={self.event.code}",
            {"emails": []},
            format="json",
        )
        self.assertEqual(empty.status_code, 400)
        too_long = self.client.post(
            f"/api/events/invitations?code={self.event.code}",
            {"emails": ["a@example.com"], "message": "x" * 1001},
            format="json",
        )
        self.assertEqual(too_long.status_code, 400)

        sent = self.client.post(
            f"/api/events/invitations?code={self.event.code}",
            {"emails": ["participant@example.com", "manual@example.com"], "message": "Join"},
            format="json",
        )
        self.assertEqual(sent.status_code, 201)
        self.assertEqual(len(sent.data["invitations"]), 2)
        self.assertEqual(
            EventInvitation.objects.get(email="participant@example.com").member,
            self.participant,
        )
        listed = self.client.get(f"/api/events/invitations?code={self.event.code}")
        self.assertEqual(len(listed.data["invitations"]), 2)

        with patch(
            "apps.scheduling.views.upsert_and_send_invitations",
            side_effect=EmailDeliveryError("ses down"),
        ):
            failed = self.client.post(
                f"/api/events/invitations?code={self.event.code}",
                {"emails": ["again@example.com"]},
                format="json",
            )
        self.assertEqual(failed.status_code, 503)

    def test_join_submit_and_reminder_api_update_invitation_status(self):
        EventInvitation.objects.create(
            event=self.event,
            email="participant@example.com",
            member=self.participant,
            invited_by=self.organizer,
        )
        self.authenticate(self.participant)
        join = self.client.post(
            f"/api/events/participants?code={self.event.code}",
            {},
            format="json",
        )
        self.assertEqual(join.status_code, 201)
        invitation = EventInvitation.objects.get(email="participant@example.com")
        self.assertEqual(invitation.status, EventInvitation.Status.ACCEPTED)

        update = self.client.put(
            f"/api/events/participants/update?code={self.event.code}&participantId={self.participant.pk}",
            {"submitted": 1},
            format="json",
        )
        self.assertEqual(update.status_code, 200)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, EventInvitation.Status.SUBMITTED)
        self.assertTrue(
            Participant.objects.get(member=self.participant, event=self.event).submitted
        )

        self.authenticate(self.participant)
        self.assertEqual(
            self.client.post(f"/api/events/reminders?code={self.event.code}").status_code,
            403,
        )
        self.assertEqual(self.client.post("/api/events/reminders").status_code, 400)
        self.assertEqual(self.client.post("/api/events/reminders?code=NOPE").status_code, 404)

        self.authenticate(self.organizer)
        reminder = self.client.post(f"/api/events/reminders?code={self.event.code}")
        self.assertEqual(reminder.status_code, 200)
        self.assertEqual(reminder.data["sent"], 0)
        EventInvitation.objects.create(
            event=self.event,
            email="pending@example.com",
            invited_by=self.organizer,
        )
        reminder = self.client.post(f"/api/events/reminders?code={self.event.code}")
        self.assertEqual(reminder.data["sent"], 1)

        with patch(
            "apps.scheduling.views.send_event_reminders",
            side_effect=EmailDeliveryError("ses down"),
        ):
            failed = self.client.post(f"/api/events/reminders?code={self.event.code}")
        self.assertEqual(failed.status_code, 503)
