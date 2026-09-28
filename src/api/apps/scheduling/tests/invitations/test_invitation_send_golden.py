"""The real invitation and reminder emails, pinned byte for byte.

Previews render these same messages with a stand-in link, so what they show
is what is sent. The digests were first taken before the link override
existed; the body and HTML pins were refreshed when the deadline changed from
an ISO timestamp to a readable time (the HTML keeps it on one line with
no-break spaces), and the calendar attachments stayed the same. They prove a real send carries the recipient's own private link in the
body, the HTML, and the calendar attachment.
"""

import hashlib
import uuid
from datetime import UTC, datetime

from django.test import TestCase, override_settings

from apps.authn.tests.helpers import create_member
from apps.scheduling.models import Event, EventInvitation
from apps.scheduling.services.invitations import event_email_parts

TOKEN = uuid.UUID("11111111-2222-4333-8444-555555555555")
DEADLINE = datetime(2026, 10, 1, 17, 0, tzinfo=UTC)
FROZEN = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)


FULL_ICS = "9ae63a4e0ebef1b1989d0b549b01f1ba3cacc759f5120469ad9a764b63adfdbd"
TEMPORARY_ICS = "38f4400dd766ba4a2764b1890fd4ebd5b244708c85f3515fe1af27b02dce799b"
GOLDEN = {
    ("full", False): ("ceda56109482630cd0d6117145fea3eb49c66ff64a6d1a4aa8026652ad470ffe", FULL_ICS),
    ("full", True): ("d53fb6051320505dd5b0f2af2d4bde0ea792f6a59f2908f26d934f2bd273dc0c", FULL_ICS),
    ("temporary", False): (
        "90eb2362c04352da5ef7e8c07a6b9f52d1519ddc1e17792916a7bb7ee1294079",
        TEMPORARY_ICS,
    ),
    ("temporary", True): (
        "c9162694dec33257f0c444248c90c723454c7de8d1d42ffb450f0633a853b750",
        TEMPORARY_ICS,
    ),
}


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@override_settings(FRONTEND_URL="https://app.releviz.test")
class InvitationSendGoldenTests(TestCase):
    maxDiff = None

    def setUp(self):
        self.organizer = create_member("golden-owner@example.com", "Olive", "Owner")
        self.event = Event.objects.create(
            event_id=uuid.UUID("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
            code="GOLDEN1",
            name="Board & <review>",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            response_deadline=DEADLINE,
            reminder_hours_before=6,
        )
        Event.objects.filter(pk=self.event.pk).update(updated_at=FROZEN)
        self.event.refresh_from_db()
        self.members = {
            access_level: create_member(
                f"golden-{access_level}@example.com",
                "Ada",
                "Lovelace",
                access_level=access_level,
            )
            for access_level in ("full", "temporary")
        }

    def invitation(self, access_level):
        member = self.members[access_level]
        return EventInvitation(
            event=self.event,
            email=member.email,
            member=member,
            access_token=TOKEN,
            custom_message="Bring <notes> & ideas",
        )

    def fingerprint(self, invitation, *, reminder):
        subject, body, html_body, attachments = event_email_parts(invitation, reminder=reminder)
        return {
            "subject": subject,
            "body": body,
            "html": digest(html_body),
            "attachments": [
                (attachment.filename, attachment.mimetype, digest(attachment.content))
                for attachment in attachments
            ],
        }

    def test_real_sends_are_unchanged(self):
        full_link = f"https://app.releviz.test/event?code=GOLDEN1&invitation={TOKEN}"
        temp_link = f"https://app.releviz.test/temp-access?code=GOLDEN1&invitation={TOKEN}"
        actual = {
            (access_level, reminder): self.fingerprint(
                self.invitation(access_level), reminder=reminder
            )
            for access_level in ("full", "temporary")
            for reminder in (False, True)
        }
        for key, (html_digest, ics_digest) in GOLDEN.items():
            with self.subTest(variant=key):
                self.assertEqual(actual[key]["html"], html_digest)
                self.assertEqual(
                    actual[key]["attachments"],
                    [
                        (
                            "releviz-GOLDEN1-availability.ics",
                            "text/calendar; charset=utf-8",
                            ics_digest,
                        )
                    ],
                )
        self.assertEqual(
            actual[("full", False)]["body"],
            "You are invited to share your availability.\n\n"
            "Event: Board & <review>\n"
            f"Link: {full_link}\n\n"
            "Please respond by Thursday, October 1, 2026 at 5:00 PM UTC.\n\n"
            "Message from organizer:\nBring <notes> & ideas\n\n"
            "Log in or create a Releviz account with this email address to fill out "
            "your schedule.",
        )
        self.assertEqual(
            actual[("temporary", True)]["body"],
            "Reminder:\n\n"
            "Event: Board & <review>\n"
            f"Link: {temp_link}\n\n"
            "Please respond by Thursday, October 1, 2026 at 5:00 PM UTC.\n\n"
            "Message from organizer:\nBring <notes> & ideas\n\n"
            "Open the link and enter the six-digit code sent to this email address.",
        )
        self.assertEqual(
            actual[("full", False)]["subject"], "Share your availability for Board & <review>"
        )
        self.assertEqual(
            actual[("full", True)]["subject"],
            "Reminder: share your availability for Board & <review>",
        )
