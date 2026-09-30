"""Previews of the final confirmation and of the cancellation a reactivation sends."""

import uuid
from datetime import timedelta
from types import SimpleNamespace

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import (
    Event,
    EventInvitation,
    FinalizationRequest,
    FinalMeeting,
    Participant,
)
from apps.scheduling.services.finalization import final_cancellation_recipients

FRONTEND = "https://app.releviz.test"
SENDER = "noreply@releviz.test"


@override_settings(FRONTEND_URL=FRONTEND, DEFAULT_FROM_EMAIL=SENDER)
class FinalEmailPreviewTests(TestCase):
    maxDiff = None

    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("final-preview-owner@example.com", "Org", "Owner")
        self.other = create_member("final-preview-other@example.com", "Other", "Person")
        self.event = Event.objects.create(
            code="FINPREV1",
            name="Final preview",
            organizer=self.organizer,
            mode="mixed",
            location="Main Room",
            timezone="UTC",
            start_minutes=9 * 60,
            end_minutes=12 * 60,
            slot_minutes=30,
            meeting_duration_minutes=120,
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
            status=Event.Status.ACTIVE,
            opened_at=timezone.now(),
        )
        # Zed and Pat were invited and are on the roster; Hana is hidden, and
        # the walk-in address never joined, so neither hears about the meeting.
        self.people = {
            label: self.person(label, hidden=label == "hana") for label in ("zed", "pat", "hana")
        }
        EventInvitation.objects.create(
            event=self.event,
            email="walk-in@example.com",
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        self.payload = {
            "startsAt": "2026-07-20T09:00:00+00:00",
            "endsAt": "2026-07-20T11:00:00+00:00",
            "channel": "inperson",
            "location": "",
        }
        self.authenticate(self.organizer)

    def person(self, label, *, hidden=False):
        member = create_member(f"{label}@example.com", label.title(), "Person")
        Participant.objects.create(
            event=self.event,
            member=member,
            participant_name=f"{label.title()} Roster",
            availability_inperson=[1] * 6,
            availability_virtual=[1] * 6,
            submitted=True,
            hidden=hidden,
        )
        EventInvitation.objects.create(
            event=self.event,
            email=member.email,
            member=member,
            invited_by=self.organizer,
            first_sent_at=timezone.now(),
        )
        return member

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def stored(self):
        return {
            "meetings": FinalMeeting.objects.count(),
            "jobs": list(
                EmailDeliveryJob.objects.order_by("pk").values_list("pk", "status", "updated_at")
            ),
            "requests": EmailDeliveryRequest.objects.count(),
            "finalizations": FinalizationRequest.objects.count(),
            "event": Event.objects.values_list("status", "version", "updated_at").get(
                pk=self.event.pk
            ),
        }

    def finalization_preview(self):
        response = self.client.post(
            f"/events/finalization/preview?code={self.event.code}", self.payload, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def confirm(self):
        self.event.refresh_from_db()
        response = self.client.put(
            f"/events/finalization?code={self.event.code}",
            {
                **self.payload,
                "expectedVersion": self.event.version,
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 202, response.data)
        self.event.refresh_from_db()
        return response.data

    def lifecycle_preview(self, payload, *, code=None):
        return self.client.post(
            f"/events/lifecycle/preview?code={code or self.event.code}", payload, format="json"
        )

    def test_finalization_preview_shows_the_confirmation_without_finalizing(self):
        before = self.stored()
        preview = self.finalization_preview()
        self.assertEqual(self.stored(), before)

        self.assertEqual(preview["recipientCount"], 2)
        self.assertEqual(preview["sample"], {"name": "Pat Roster", "email": "pat@example.com"})
        self.assertEqual(preview["attendance"]["availableParticipantTotal"], 2)
        email = preview["email"]
        self.assertEqual(email["from"], SENDER)
        self.assertEqual(email["to"], "Pat Roster <pat@example.com>")
        self.assertEqual(email["subject"], "Confirmed: Final preview")
        self.assertEqual(email["attachments"], ["releviz-FINPREV1-final.ics"])
        # The proposed time as recipients read it, with the event's location
        # standing in for a blank one.
        self.assertIn("When: Monday, July 20, 2026, 9:00 AM to 11:00 AM UTC\n", email["text"])
        self.assertIn("Method: In person\n", email["text"])
        self.assertIn("Location: Main Room\n", email["text"])
        self.assertIn("Meeting confirmed", email["html"])

        self.confirm()
        job = EmailDeliveryJob.objects.get(
            message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION,
            recipient="pat@example.com",
        )
        self.assertEqual(email["subject"], job.subject)
        self.assertEqual(email["text"], job.body)
        self.assertEqual(email["html"], job.html_body)
        self.assertEqual(
            EmailDeliveryJob.objects.filter(
                message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION
            ).count(),
            preview["recipientCount"],
        )

    def test_finalization_preview_without_invited_people_has_no_email(self):
        EventInvitation.objects.update(first_sent_at=None)
        preview = self.finalization_preview()
        self.assertEqual(preview["recipientCount"], 0)
        self.assertIsNone(preview["email"])
        self.assertIsNone(preview["sample"])

    def test_reactivation_preview_names_the_cancellations_the_reopen_sends(self):
        self.confirm()
        statuses = {
            "pat@example.com": EmailDeliveryJob.Status.SENT,
            "zed@example.com": EmailDeliveryJob.Status.PROCESSING,
        }
        for recipient, status in statuses.items():
            EmailDeliveryJob.objects.filter(recipient=recipient).update(status=status)
        # A third confirmation still waiting to go out is canceled, not followed up.
        waiting = self.person("wes")
        EmailDeliveryJob.objects.create(
            idempotency_key=f"final-confirmation:{self.event.event_id}:0:wes",
            message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION,
            recipient=waiting.email,
            subject="Confirmed",
            body="Confirmed",
            message_id="<wes@releviz.local>",
            event=self.event,
        )
        deadline = (timezone.now() + timedelta(days=3)).isoformat()
        before = self.stored()

        response = self.lifecycle_preview({"status": "active", "responseDeadline": deadline})

        self.assertEqual(response.status_code, 200, response.data)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(self.stored(), before)
        self.assertTrue(FinalMeeting.objects.get(event=self.event).active)
        cancellation = response.data["cancellation"]
        self.assertEqual(cancellation["recipientCount"], 2)
        self.assertEqual(cancellation["sample"], {"name": "Pat Roster", "email": "pat@example.com"})
        email = cancellation["email"]
        self.assertEqual(email["to"], "Pat Roster <pat@example.com>")
        self.assertEqual(email["subject"], "Scheduling reopened: Final preview")
        self.assertEqual(email["attachments"], ["releviz-FINPREV1-final.ics"])
        self.assertIn("Scheduling for Final preview has reopened.", email["text"])

        reopened = self.client.put(
            f"/events/lifecycle?code={self.event.code}",
            {
                "status": "active",
                "expectedVersion": self.event.version,
                "responseDeadline": deadline,
            },
            format="json",
        )
        self.assertEqual(reopened.status_code, 202, reopened.data)
        sent = EmailDeliveryJob.objects.filter(
            message_type=EmailMessageLog.MessageType.FINAL_CANCELLATION
        ).order_by("recipient")
        self.assertEqual(
            list(sent.values_list("recipient", flat=True)),
            ["pat@example.com", "zed@example.com"],
        )
        self.assertEqual(reopened.data["cancellationEnqueued"], cancellation["recipientCount"])
        first = sent.first()
        self.assertEqual(email["subject"], first.subject)
        self.assertEqual(email["text"], first.body)
        self.assertEqual(email["html"], first.html_body)

        # Once reopened there is no confirmed meeting left to cancel.
        self.event.refresh_from_db()
        for status in ("active", "closed"):
            with self.subTest(status=status):
                again = self.lifecycle_preview({"status": status})
                self.assertEqual(again.status_code, 200, again.data)
                self.assertEqual(
                    again.data["cancellation"],
                    {"recipientCount": 0, "email": None, "sample": None},
                )

    def test_archiving_a_finalized_event_keeps_its_meeting_until_it_is_reopened(self):
        self.confirm()
        EmailDeliveryJob.objects.filter(
            message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION
        ).update(status=EmailDeliveryJob.Status.SENT)

        archived = self.client.put(
            f"/events/lifecycle?code={self.event.code}",
            {"status": "archived", "expectedVersion": self.event.version},
            format="json",
        )

        self.assertEqual(archived.status_code, 200, archived.data)
        self.assertEqual(archived.data["event"]["status"], "archived")
        self.assertEqual(archived.data["cancellationEnqueued"], 0)
        self.assertTrue(archived.data["event"]["finalMeeting"]["active"])
        self.assertFalse(
            EmailDeliveryJob.objects.filter(
                message_type=EmailMessageLog.MessageType.FINAL_CANCELLATION
            ).exists()
        )

        # The meeting still stands, so reopening the archived event is
        # previewed and cancelled exactly like reopening a finalized one.
        self.event.refresh_from_db()
        preview = self.lifecycle_preview({"status": "active"})
        self.assertEqual(preview.data["cancellation"]["recipientCount"], 2)
        reopened = self.client.put(
            f"/events/lifecycle?code={self.event.code}",
            {"status": "active", "expectedVersion": self.event.version},
            format="json",
        )
        self.assertEqual(reopened.status_code, 202, reopened.data)
        self.assertEqual(reopened.data["cancellationEnqueued"], 2)
        self.assertIsNone(reopened.data["event"]["finalMeeting"])

    def test_reopening_a_closed_event_without_a_meeting_cancels_nothing(self):
        self.event.status = Event.Status.CLOSED
        self.event.save(update_fields=["status", "updated_at"])
        response = self.lifecycle_preview({"status": "active", "responseDeadline": None})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(
            response.data["cancellation"], {"recipientCount": 0, "email": None, "sample": None}
        )

    def test_reactivation_preview_refuses_what_the_change_would_refuse(self):
        self.assertEqual(
            self.client.post("/events/lifecycle/preview", {}, format="json").status_code, 400
        )
        self.assertEqual(
            self.lifecycle_preview({"status": "active"}, code="MISSING").status_code, 404
        )
        self.authenticate(self.other)
        denied = self.lifecycle_preview({"status": "active"})
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.data["error"], "Only the organizer can change event lifecycle")
        self.authenticate(self.organizer)

        malformed = self.lifecycle_preview({"status": "active", "responseDeadline": "soon"})
        self.assertEqual(malformed.status_code, 400)
        self.assertEqual(malformed.data["error"], "responseDeadline must be an ISO datetime")

        self.confirm()
        past = (timezone.now() - timedelta(hours=1)).replace(tzinfo=None).isoformat()
        for payload, message in (
            ({"status": "finalized"}, "Confirm a final meeting time to finalize the event."),
            ({"status": "closed"}, "Cannot transition an event from finalized to closed."),
            ({"status": "paused"}, "Invalid event status."),
            (
                {"status": "active", "responseDeadline": past},
                "An active event must have a future response deadline.",
            ),
        ):
            with self.subTest(payload=payload):
                response = self.lifecycle_preview(payload)
                self.assertEqual(response.status_code, 409, response.data)
                self.assertEqual(response.data["error"], message)

    def test_cancellation_recipients_are_the_confirmations_that_may_have_arrived(self):
        statuses = EmailDeliveryJob.Status
        jobs = [
            SimpleNamespace(recipient=f"{status}@example.com", status=status)
            for status in statuses.values
        ] + [SimpleNamespace(recipient="sent@example.com", status=statuses.SENT)]
        self.assertEqual(
            final_cancellation_recipients(jobs),
            [f"{statuses.PROCESSING}@example.com", f"{statuses.SENT}@example.com"],
        )
