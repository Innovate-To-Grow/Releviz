"""The real final confirmation and cancellation emails, pinned byte for byte.

Previews build these messages through the same parts the send uses, so what
they show is what is sent. The digests were first taken before those parts
were factored out. They were refreshed when the confirmation and the calendar
description changed from ISO timestamps and stored codes to readable times and
labels (the HTML keeps each time on one line with no-break spaces); the
cancellation email's text and HTML stayed the same.
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
                    "When: Monday, October 5, 2026, 9:00 AM to 10:00 AM CEST\n"
                    "Timezone: Europe/Berlin\n"
                    "Method: In person\n"
                    "Location: Room <4>, Main St.\n"
                    "Event: https://app.releviz.test/event?code=GOLDFIN1\n\n"
                    "A calendar invitation is attached."
                ),
                "html": "b78d93c35eacc3387c308fdcaabbf6ea607bc2c40adefa7cb7101a10778008b8",
                "attachments": [
                    (
                        "releviz-GOLDFIN1-final.ics",
                        "text/calendar; charset=utf-8; method=request",
                        "47afa7522a63e756eb4225f56d4334e49be768d7b0bedffdf520d6a40240bd03",
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
                        "c325e117b02a6c6a11c76c3b2449a37cd124703e0bcf100c0f82bf041aaa689b",
                    )
                ],
            },
        )
