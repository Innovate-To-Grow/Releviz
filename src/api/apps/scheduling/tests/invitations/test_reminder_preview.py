"""The reminder preview: what a manual reminder run would do, without doing it."""

import uuid
from datetime import timedelta
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.security import consume_request_rate_limit
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.mail.services import enqueue_email_job
from apps.scheduling.models import Event, EventInvitation
from apps.scheduling.services.invitations import (
    enqueue_reminder_job,
    event_email_parts,
    reminder_cycle,
)
from apps.scheduling.services.invitations.reminders import (
    next_automatic_reminder_at,
    reminded_invitation_ids,
    reminder_job_key_prefix,
)


class ReminderPreviewApiTests(TestCase):
    def setUp(self):
        self.organizer = create_member("reminder-owner@example.com", "Org", "Owner")
        self.outsider = create_member("reminder-outsider@example.com", "Other", "Person")
        self.deadline = timezone.now() + timedelta(hours=24)
        self.event = Event.objects.create(
            code="REMPREV1",
            name="Reminder preview",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            response_deadline=self.deadline,
            reminder_hours_before=1,
        )
        self.client = APIClient()
        self.authenticate(self.organizer)
        self.sent = self.invite("sent@example.com", sent=True)
        self.invite("submitted@example.com", sent=True, status=EventInvitation.Status.SUBMITTED)
        self.invite("never-sent@example.com", sent=False)

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def invite(self, email, *, sent, status=EventInvitation.Status.INVITED):
        return EventInvitation.objects.create(
            event=self.event,
            email=email,
            invited_by=self.organizer,
            first_sent_at=timezone.now() if sent else None,
            status=status,
        )

    def preview(self, **extra):
        return self.client.post(
            f"/events/reminders?code={self.event.code}",
            {"preview": True, **extra},
            format="json",
        )

    def send(self):
        return self.client.post(
            f"/events/reminders?code={self.event.code}",
            {"idempotencyKey": str(uuid.uuid4())},
            format="json",
        )

    def test_preview_reports_eligibility_without_side_effects_or_quota(self):
        with patch(
            "apps.scheduling.views.invitations.reminders.consume_request_rate_limit"
        ) as consume:
            response = self.preview()
        self.assertEqual(response.status_code, 200, response.data)
        email = response.data.pop("email")
        self.assertEqual(
            response.data,
            {
                "preview": True,
                "remindersEnabled": True,
                "eligible": 1,
                "alreadyReminded": 0,
                "wouldEnqueue": 1,
                "nextAutomaticAt": (self.deadline - timedelta(hours=1)).isoformat(),
                "deadline": self.deadline.isoformat(),
                # The reminder the run would send, shown for its one recipient.
                "sample": {"name": "", "email": "sent@example.com"},
            },
        )
        self.assertEqual(email["to"], "sent@example.com")
        consume.assert_not_called()
        self.assertFalse(EmailDeliveryRequest.objects.exists())
        self.assertFalse(EmailDeliveryJob.objects.exists())

        # A real run queues the one reminder; the next preview knows it.
        sent = self.send()
        self.assertEqual(sent.status_code, 202, sent.data)
        self.assertEqual(sent.data["enqueued"], 1)
        again = self.preview()
        self.assertEqual(again.data["eligible"], 1)
        self.assertEqual(again.data["alreadyReminded"], 1)
        self.assertEqual(again.data["wouldEnqueue"], 0)

        # Whatever became of that reminder, this cycle already had one.
        EmailDeliveryJob.objects.update(status=EmailDeliveryJob.Status.PERMANENT_FAILURE)
        self.assertEqual(self.preview().data["alreadyReminded"], 1)

        # A new deadline starts a new cycle, so everyone is due again.
        self.event.response_deadline += timedelta(days=1)
        self.event.save(update_fields=["response_deadline", "updated_at"])
        moved = self.preview()
        self.assertEqual(moved.data["alreadyReminded"], 0)
        self.assertEqual(moved.data["wouldEnqueue"], 1)
        self.assertEqual(moved.data["deadline"], self.event.response_deadline.isoformat())

    def test_preview_shows_when_reminders_are_off_or_no_longer_due(self):
        self.event.reminders_enabled = False
        self.event.save(update_fields=["reminders_enabled", "updated_at"])
        disabled = self.preview()
        self.assertEqual(disabled.status_code, 200, disabled.data)
        self.assertFalse(disabled.data["remindersEnabled"])
        # Eligibility ignores the switch so the organizer sees who a run would reach.
        self.assertEqual(disabled.data["eligible"], 1)
        self.assertEqual(disabled.data["wouldEnqueue"], 1)
        self.assertIsNone(disabled.data["nextAutomaticAt"])

        self.event.reminders_enabled = True
        self.event.reminder_hours_before = 48
        self.event.save(update_fields=["reminders_enabled", "reminder_hours_before", "updated_at"])
        # The automatic reminder would already have gone out.
        self.assertIsNone(self.preview().data["nextAutomaticAt"])

        self.event.reminder_hours_before = 1
        self.event.response_deadline = timezone.now() - timedelta(minutes=5)
        self.event.save(update_fields=["reminder_hours_before", "response_deadline", "updated_at"])
        # Past the deadline a run is refused, but the preview still answers.
        self.assertEqual(self.send().status_code, 409)
        passed = self.preview()
        self.assertEqual(passed.status_code, 200, passed.data)
        self.assertIsNone(passed.data["nextAutomaticAt"])
        self.assertEqual(passed.data["deadline"], self.event.response_deadline.isoformat())
        self.assertEqual(passed.data["eligible"], 1)

        self.event.response_deadline = None
        self.event.save(update_fields=["response_deadline", "updated_at"])
        open_ended = self.preview()
        self.assertIsNone(open_ended.data["deadline"])
        self.assertIsNone(open_ended.data["nextAutomaticAt"])

        self.event.response_deadline = self.deadline
        self.event.status = Event.Status.CLOSED
        self.event.closed_at = timezone.now()
        self.event.save(update_fields=["response_deadline", "status", "closed_at", "updated_at"])
        closed = self.preview()
        self.assertEqual(closed.status_code, 200, closed.data)
        self.assertIsNone(closed.data["nextAutomaticAt"])

    def test_preview_spends_no_request_budget_while_a_run_does(self):
        with patch(
            "apps.authn.security.helpers.consume_request_rate_limit",
            wraps=consume_request_rate_limit,
        ) as consume:
            self.assertEqual(self.preview().status_code, 200)
            consume.assert_not_called()
            self.assertEqual(self.send().status_code, 202)
        # The throttle's own call; the view's recipient charge binds the
        # helper separately and is covered by the send tests.
        self.assertEqual([call.args[0] for call in consume.call_args_list], ["reminder_request"])

    def test_preview_guards_and_validation(self):
        self.authenticate(self.outsider)
        self.assertEqual(self.preview().status_code, 403)
        self.authenticate(self.organizer)

        invalid = self.preview(preview="yes")
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.data["error"], "preview must be a boolean.")

        # An explicit false is a real run, which still needs its key.
        not_preview = self.preview(preview=False)
        self.assertEqual(not_preview.status_code, 400)
        self.assertEqual(not_preview.data["error"], "idempotencyKey must be a UUID")

    def test_a_run_emails_exactly_the_people_the_preview_counted(self):
        """Anyone this cycle already reminded is skipped, whatever the reminder said.

        A reminder's wording can change within a cycle: the event is renamed,
        or any change to the event restamps the deadline's calendar file. A
        run still skips everyone the preview counted as already reminded, so
        it emails exactly the people the organizer confirmed.
        """

        people = [
            self.sent,
            *(self.invite(f"p{index}@example.com", sent=True) for index in range(4)),
        ]
        by_email = {invitation.email: invitation for invitation in people}
        old_jobs = {
            email: enqueue_reminder_job(by_email[email])[0]
            for email in ["p0@example.com", "p1@example.com"]
        }
        Event.objects.filter(pk=self.event.pk).update(name="Renamed event")
        # p0 also holds this cycle's reminder under the new name; the newest
        # of her reminders is the one that counts.
        self.event.refresh_from_db()
        by_email["p0@example.com"].event = self.event
        newest_p0, _created = enqueue_reminder_job(by_email["p0@example.com"])

        preview = self.preview().data
        self.assertEqual(
            (preview["eligible"], preview["alreadyReminded"], preview["wouldEnqueue"]),
            (5, 2, 3),
        )
        self.assertEqual(preview["sample"]["email"], "p2@example.com")
        self.assertEqual(
            preview["email"]["subject"], "Reminder: share your availability for Renamed event"
        )

        jobs_before = set(EmailDeliveryJob.objects.values_list("pk", flat=True))
        sent = self.send()
        self.assertEqual(sent.status_code, 202, sent.data)
        self.assertEqual(sent.data["enqueued"], preview["wouldEnqueue"])
        self.assertEqual(sent.data["recipientCount"], preview["eligible"])
        self.assertEqual(sent.data["deduplicated"], preview["alreadyReminded"])
        new_jobs = EmailDeliveryJob.objects.exclude(pk__in=jobs_before)
        self.assertEqual(
            sorted(new_jobs.values_list("recipient", flat=True)),
            ["p2@example.com", "p3@example.com", "sent@example.com"],
        )
        # The skipped people's latest reminders stand for them in the run.
        request_record = EmailDeliveryRequest.objects.get(pk=sent.data["deliveryRequestId"])
        self.assertEqual(
            set(request_record.jobs.values_list("pk", flat=True)),
            {newest_p0.pk, old_jobs["p1@example.com"].pk, *new_jobs.values_list("pk", flat=True)},
        )

        # Any later change to the event restamps the deadline's calendar file
        # in every reminder, and still nobody reminded this cycle is emailed
        # again.
        invitation = EventInvitation.objects.select_related("event").get(pk=self.sent.pk)
        calendar_file = event_email_parts(invitation, reminder=True)[3][0].content
        Event.objects.filter(pk=self.event.pk).update(
            updated_at=timezone.now() + timedelta(hours=1)
        )
        invitation.event.refresh_from_db()
        self.assertNotEqual(
            event_email_parts(invitation, reminder=True)[3][0].content, calendar_file
        )
        again = self.preview().data
        self.assertEqual((again["alreadyReminded"], again["wouldEnqueue"]), (5, 0))
        rerun = self.send()
        self.assertEqual(rerun.status_code, 202, rerun.data)
        self.assertEqual((rerun.data["enqueued"], rerun.data["deduplicated"]), (0, 5))
        self.assertEqual(EmailDeliveryJob.objects.count(), len(jobs_before) + 3)

    def test_reminded_ids_match_only_this_cycle_and_these_invitations(self):
        other = self.invite("other@example.com", sent=True)
        cycle = reminder_cycle(self.event)
        for label, invitation, prefix in [
            ("current", self.sent, reminder_job_key_prefix(self.event, self.sent.pk, cycle)),
            ("stale", other, reminder_job_key_prefix(self.event, other.pk, "oldcycle")),
        ]:
            enqueue_email_job(
                idempotency_key=f"{prefix}{label}",
                message_type=EmailMessageLog.MessageType.REMINDER,
                recipient=invitation.email,
                subject="Reminder",
                body="Reminder",
                message_id=f"<reminder-{label}@releviz.local>",
                event=self.event,
                invitation=invitation,
            )
        self.assertEqual(
            reminded_invitation_ids(self.event, [self.sent.pk, other.pk]),
            {self.sent.pk},
        )
        self.assertEqual(reminded_invitation_ids(self.event, [other.pk]), set())
        self.assertEqual(reminded_invitation_ids(self.event, []), set())

    def test_next_automatic_reminder_uses_the_given_clock(self):
        reminder_at = self.deadline - timedelta(hours=1)
        self.assertEqual(next_automatic_reminder_at(self.event), reminder_at)
        self.assertEqual(
            next_automatic_reminder_at(self.event, now=reminder_at - timedelta(seconds=1)),
            reminder_at,
        )
        self.assertIsNone(next_automatic_reminder_at(self.event, now=reminder_at))
