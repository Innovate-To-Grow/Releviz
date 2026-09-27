"""The real final confirmation and cancellation emails, pinned byte for byte.

Previews build these messages through the same parts the send uses. These
digests were taken before those parts were factored out, so they prove the
queued emails are exactly what they were.
"""

import hashlib
import uuid
from datetime import UTC, datetime

from django.test import TestCase, override_settings

from apps.authn.tests.helpers import create_member
from apps.scheduling.models import Event, FinalMeeting
from apps.scheduling.services.finalization import (
    enqueue_final_cancellation_jobs,
    enqueue_final_confirmation_jobs,
)

RECIPIENT = "ada@example.com"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@override_settings(FRONTEND_URL="https://app.releviz.test")
class FinalSendGoldenTests(TestCase):
    maxDiff = None

    def setUp(self):
        self.organizer = create_member("golden-final-owner@example.com", "Olive", "Owner")
        self.event = Event.objects.create(
            event_id=uuid.UUID("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"),
            code="GOLDFIN1",
            name="Board & <review>",
            organizer=self.organizer,
            status=Event.Status.FINALIZED,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            timezone="Europe/Berlin",
        )
        self.meeting = FinalMeeting(
            starts_at=datetime(2026, 10, 5, 7, 0, tzinfo=UTC),
            ends_at=datetime(2026, 10, 5, 8, 0, tzinfo=UTC),
            timezone="Europe/Berlin",
            channel="inperson",
            location="Room <4>, Main St.",
            calendar_uid="final-golden@releviz",
            calendar_sequence=3,
            confirmed_at=datetime(2026, 9, 1, 12, 0, tzinfo=UTC),
        )

    def fingerprint(self, job):
        return {
            "subject": job.subject,
            "body": job.body,
            "html": digest(job.html_body),
            "attachments": [
                (attachment["filename"], attachment["mimetype"], digest(attachment["content"]))
                for attachment in job.attachments
            ],
        }

    def test_confirmation_is_unchanged(self):
        (job,) = enqueue_final_confirmation_jobs(self.event, self.meeting, [RECIPIENT])
        self.assertEqual(
            self.fingerprint(job),
            {
                "subject": "Confirmed: Board & <review>",
                "body": (
                    "The final meeting time for Board & <review> is confirmed.\n\n"
                    "Starts: 2026-10-05T09:00:00+02:00\n"
                    "Ends: 2026-10-05T10:00:00+02:00\n"
                    "Timezone: Europe/Berlin\n"
                    "Method: inperson\n"
                    "Location: Room <4>, Main St.\n"
                    "Event: https://app.releviz.test/event?code=GOLDFIN1\n\n"
                    "A calendar invitation is attached."
                ),
                "html": "cdd038235fbde9a0ba4ca66ce8dcd94d83abed060519f81c513156d9bde2b15a",
                "attachments": [
                    (
                        "releviz-GOLDFIN1-final.ics",
                        "text/calendar; charset=utf-8; method=request",
                        "2b949048969752548dc6259d937c4cd3beddcccc029bd343989122e12361e429",
                    )
                ],
            },
        )

    def test_cancellation_is_unchanged(self):
        (job,) = enqueue_final_cancellation_jobs(self.event, self.meeting, [RECIPIENT])
        self.assertEqual(
            self.fingerprint(job),
            {
                "subject": "Scheduling reopened: Board & <review>",
                "body": (
                    "Scheduling for Board & <review> has reopened.\n\n"
                    "The previously confirmed calendar invitation has been canceled. "
                    "Check the event for updates: "
                    "https://app.releviz.test/event?code=GOLDFIN1"
                ),
                "html": "cbd18a532574f18e591c49f54931af6d6c0dabad0d02d9dd2ee3a5afab305333",
                "attachments": [
                    (
                        "releviz-GOLDFIN1-final.ics",
                        "text/calendar; charset=utf-8; method=cancel",
                        "3966b82aeb5817cf83319d65449c1b6a50c6a8c9610925862fe3364036bcc8da",
                    )
                ],
            },
        )
