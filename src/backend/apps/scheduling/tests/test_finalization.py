import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from django.core import mail
from django.core.exceptions import ValidationError
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail
from apps.authn.tests.helpers import create_member, token_for
from apps.messaging.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.finalization import (
    FinalizationError,
    build_attendance_review,
    cancel_active_final_meeting,
    confirm_final_meeting,
    final_delivery_summary,
    final_notification_recipients,
    normalize_final_time,
)
from apps.scheduling.models import (
    Event,
    EventInvitation,
    FinalizationRequest,
    FinalMeeting,
    Participant,
    Weight,
)
from apps.scheduling.services import final_meeting_ics
from apps.scheduling.slots import build_event_slot_groups
from apps.scheduling.utils import api_event, api_final_meeting
from apps.scheduling.validators import validate_iana_timezone


def stored(values):
    return list(values)


class FinalizationDomainTests(TestCase):
    def setUp(self):
        self.organizer = create_member("final-organizer@example.com", "Org", "Owner")
        self.other = create_member("final-other@example.com", "Other", "User")
        self.event = Event.objects.create(
            code="FINALDOM",
            name="Final Domain",
            organizer=self.organizer,
            mode="mixed",
            location="Room 101",
            timezone="America/Los_Angeles",
            start_minutes=9 * 60,
            end_minutes=12 * 60,
            slot_minutes=30,
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20", "2026-07-21"],
            status=Event.Status.OPEN,
            opened_at=timezone.now(),
        )
        self.members = {}

    def participant(
        self,
        label,
        values,
        *,
        submitted=True,
        hidden=False,
        required=False,
        included=True,
    ):
        member = create_member(f"{label}@example.com", label.title(), "Person")
        participant = Participant.objects.create(
            event=self.event,
            member=member,
            participant_name=member.display_name(),
            availability_inperson=stored(values),
            availability_virtual=stored(values),
            submitted=submitted,
            hidden=hidden,
        )
        if required or not included:
            Weight.objects.create(
                event=self.event,
                participant=participant,
                required=required,
                included=included,
            )
        self.members[label] = member
        return participant

    def normalized(self, *, start_hour=9, end_hour=11, channel="inperson", location=""):
        return normalize_final_time(
            self.event,
            starts_at=datetime(2026, 7, 20, start_hour + 7, tzinfo=UTC),
            ends_at=datetime(2026, 7, 20, end_hour + 7, tzinfo=UTC),
            channel=channel,
            location=location,
        )

    def seed_responses(self):
        self.participant("available", [1, 1, 1, 1] + [0] * 8)
        self.participant("partial", [1, 1, 0.5, 0.5] + [0] * 8, required=True)
        self.participant("unavailable", [0] * 12)
        self.participant("unanswered", [0] * 12, submitted=False, required=True)
        hidden = self.participant("hidden", [1, 1, 1, 1] + [0] * 8, hidden=True)
        self.participant(
            "excluded",
            [1, 1, 1, 1] + [0] * 8,
            required=True,
            included=False,
        )
        EventInvitation.objects.create(
            event=self.event,
            email="manual@example.com",
            invited_by=self.organizer,
        )
        EventInvitation.objects.create(
            event=self.event,
            email=hidden.member.email,
            member=hidden.member,
            invited_by=self.organizer,
        )

    def test_attendance_review_recipient_rules_and_api_shapes(self):
        self.seed_responses()
        normalized = self.normalized()
        review = build_attendance_review(self.event, normalized)

        self.assertEqual(review["slotIndices"], [0, 1, 2, 3])
        self.assertEqual(review["countedResponseTotal"], 3)
        self.assertEqual(review["availableParticipantTotal"], 1)
        self.assertEqual(review["partialParticipantTotal"], 1)
        self.assertEqual(review["unavailableParticipantTotal"], 1)
        self.assertEqual(review["unansweredParticipantTotal"], 1)
        self.assertEqual(review["excludedParticipantTotal"], 2)
        self.assertEqual(review["requiredConflictTotal"], 3)
        self.assertEqual(
            [participant["status"] for participant in review["participants"]],
            ["available", "partial", "unavailable"],
        )
        self.assertEqual(
            final_notification_recipients(self.event),
            [
                "available@example.com",
                "excluded@example.com",
                "manual@example.com",
                "partial@example.com",
                "unanswered@example.com",
                "unavailable@example.com",
            ],
        )

        result = confirm_final_meeting(
            event_code=self.event.code,
            organizer=self.organizer,
            expected_version=self.event.version,
            idempotency_key=uuid.uuid4(),
            starts_at=normalized["starts_at"],
            ends_at=normalized["ends_at"],
            channel="inperson",
            location="",
        )
        self.assertFalse(result["idempotent"])
        self.assertEqual(len(result["jobs"]), 6)
        self.event.refresh_from_db()
        meeting = FinalMeeting.objects.get(event=self.event)
        self.assertEqual(self.event.status, Event.Status.FINALIZED)
        self.assertEqual(self.event.version, 2)
        self.assertEqual(meeting.location, "Room 101")
        self.assertTrue(meeting.active)
        self.assertEqual(FinalizationRequest.objects.count(), 1)
        self.assertEqual(final_delivery_summary(self.event, meeting)["pending"], 6)
        self.assertEqual(api_event(self.event)["finalMeeting"]["calendarSequence"], 0)
        self.assertIn("attendance", api_final_meeting(meeting, include_attendance=True))
        self.assertIn("[active]", str(meeting))
        request = FinalizationRequest.objects.get()
        self.assertIn(str(request.idempotency_key), str(request))

    def test_confirmation_idempotency_conflicts_reopen_and_reconfirmation(self):
        self.participant("available", [1, 1, 1, 1] + [0] * 8)
        key = uuid.uuid4()
        normalized = self.normalized()
        first = confirm_final_meeting(
            event_code=self.event.code,
            organizer=self.organizer,
            expected_version=1,
            idempotency_key=key,
            starts_at=normalized["starts_at"],
            ends_at=normalized["ends_at"],
            channel="inperson",
            location="Room 101",
        )
        duplicate = confirm_final_meeting(
            event_code=self.event.code,
            organizer=self.organizer,
            expected_version=1,
            idempotency_key=key,
            starts_at=normalized["starts_at"],
            ends_at=normalized["ends_at"],
            channel="inperson",
            location="Room 101",
        )
        self.assertTrue(duplicate["idempotent"])
        self.assertEqual(duplicate["jobs"], [])
        repeated_with_new_key = confirm_final_meeting(
            event_code=self.event.code,
            organizer=self.organizer,
            expected_version=1,
            idempotency_key=uuid.uuid4(),
            starts_at=normalized["starts_at"],
            ends_at=normalized["ends_at"],
            channel="inperson",
            location="Room 101",
        )
        self.assertTrue(repeated_with_new_key["idempotent"])
        self.assertEqual(EmailDeliveryJob.objects.count(), 1)

        with self.assertRaisesMessage(FinalizationError, "different final-time details"):
            confirm_final_meeting(
                event_code=self.event.code,
                organizer=self.organizer,
                expected_version=1,
                idempotency_key=key,
                starts_at=normalized["starts_at"],
                ends_at=normalized["ends_at"] + timedelta(hours=1),
                channel="inperson",
                location="Room 101",
            )
        with self.assertRaisesMessage(FinalizationError, "Reopen the event"):
            confirm_final_meeting(
                event_code=self.event.code,
                organizer=self.organizer,
                expected_version=2,
                idempotency_key=uuid.uuid4(),
                starts_at=normalized["starts_at"] + timedelta(hours=1),
                ends_at=normalized["ends_at"] + timedelta(hours=1),
                channel="inperson",
                location="Room 101",
            )

        self.event.refresh_from_db()
        jobs = cancel_active_final_meeting(self.event)
        meeting = first["meeting"]
        meeting.refresh_from_db()
        self.assertFalse(meeting.active)
        self.assertEqual(meeting.calendar_sequence, 1)
        self.assertEqual(len(jobs), 1)
        self.assertIn("METHOD:CANCEL", jobs[0].attachments[0]["content"])
        self.assertIn("[canceled]", str(meeting))
        self.assertEqual(cancel_active_final_meeting(self.event), [])

        with self.assertRaisesMessage(FinalizationError, "superseded"):
            confirm_final_meeting(
                event_code=self.event.code,
                organizer=self.organizer,
                expected_version=2,
                idempotency_key=key,
                starts_at=normalized["starts_at"],
                ends_at=normalized["ends_at"],
                channel="inperson",
                location="Room 101",
            )

        self.event.status = Event.Status.OPEN
        self.event.version = 3
        self.event.save(update_fields=["status", "version", "updated_at"])
        reconfirmed = confirm_final_meeting(
            event_code=self.event.code,
            organizer=self.organizer,
            expected_version=3,
            idempotency_key=uuid.uuid4(),
            starts_at=normalized["starts_at"] + timedelta(hours=1),
            ends_at=normalized["ends_at"] + timedelta(hours=1),
            channel="inperson",
            location="Room 202",
        )
        reconfirmed["meeting"].refresh_from_db()
        self.assertEqual(reconfirmed["meeting"].calendar_sequence, 2)
        self.assertEqual(
            reconfirmed["meeting"].calendar_uid,
            first["meeting"].calendar_uid,
        )

    def test_confirmation_permissions_versions_and_statuses(self):
        normalized = self.normalized()
        with self.assertRaisesMessage(FinalizationError, "Event not found"):
            confirm_final_meeting(
                event_code="NOPE",
                organizer=self.organizer,
                expected_version=1,
                idempotency_key=uuid.uuid4(),
                starts_at=normalized["starts_at"],
                ends_at=normalized["ends_at"],
                channel="inperson",
                location="",
            )
        with self.assertRaisesMessage(FinalizationError, "Only the organizer"):
            confirm_final_meeting(
                event_code=self.event.code,
                organizer=self.other,
                expected_version=1,
                idempotency_key=uuid.uuid4(),
                starts_at=normalized["starts_at"],
                ends_at=normalized["ends_at"],
                channel="inperson",
                location="",
            )
        with self.assertRaisesMessage(FinalizationError, "changed in another session"):
            confirm_final_meeting(
                event_code=self.event.code,
                organizer=self.organizer,
                expected_version=999,
                idempotency_key=uuid.uuid4(),
                starts_at=normalized["starts_at"],
                ends_at=normalized["ends_at"],
                channel="inperson",
                location="",
            )

        self.event.status = Event.Status.DRAFT
        self.event.save(update_fields=["status", "updated_at"])
        with self.assertRaisesMessage(FinalizationError, "while it is draft"):
            confirm_final_meeting(
                event_code=self.event.code,
                organizer=self.organizer,
                expected_version=1,
                idempotency_key=uuid.uuid4(),
                starts_at=normalized["starts_at"],
                ends_at=normalized["ends_at"],
                channel="inperson",
                location="",
            )

        self.event.status = Event.Status.CLOSED
        self.event.save(update_fields=["status", "updated_at"])
        result = confirm_final_meeting(
            event_code=self.event.code,
            organizer=self.organizer,
            expected_version=1,
            idempotency_key=uuid.uuid4(),
            starts_at=normalized["starts_at"],
            ends_at=normalized["ends_at"],
            channel="virtual",
            location="",
        )
        self.assertEqual(result["meeting"].location, "Room 101")

    def test_time_validation_timezone_dst_and_midnight_rules(self):
        naive = datetime(2026, 7, 20, 9)
        with self.assertRaisesMessage(FinalizationError, "explicit UTC offset"):
            normalize_final_time(
                self.event,
                starts_at=naive,
                ends_at=naive + timedelta(hours=1),
                channel="inperson",
                location="",
            )
        with self.assertRaisesMessage(FinalizationError, "after its start"):
            self.normalized(start_hour=10, end_hour=10)
        with self.assertRaisesMessage(FinalizationError, "not valid"):
            self.normalized(channel="")
        with self.assertRaisesMessage(FinalizationError, "30-minute slots"):
            normalize_final_time(
                self.event,
                starts_at=datetime(2026, 7, 20, 16, 10, tzinfo=UTC),
                ends_at=datetime(2026, 7, 20, 17, 10, tzinfo=UTC),
                channel="inperson",
                location="",
            )
        with self.assertRaisesMessage(FinalizationError, "configured event date"):
            self.normalized(start_hour=8, end_hour=9)
        with self.assertRaisesMessage(FinalizationError, "configured event date"):
            normalize_final_time(
                self.event,
                starts_at=datetime(2026, 7, 22, 16, tzinfo=UTC),
                ends_at=datetime(2026, 7, 22, 17, tzinfo=UTC),
                channel="inperson",
                location="",
            )
        with self.assertRaisesMessage(FinalizationError, "location is too long"):
            self.normalized(location="x" * 501)

        weekly = Event.objects.create(
            code="WEEKFINAL",
            name="Weekly",
            organizer=self.organizer,
            mode="virtual",
            timezone="UTC",
            days=[1],
            start_minutes=9 * 60,
            end_minutes=11 * 60,
            slot_minutes=30,
        )
        with self.assertRaisesMessage(FinalizationError, "not enabled"):
            normalize_final_time(
                weekly,
                starts_at=datetime(2026, 7, 21, 9, tzinfo=UTC),
                ends_at=datetime(2026, 7, 21, 10, tzinfo=UTC),
                channel="virtual",
                location="",
            )
        valid_weekly = normalize_final_time(
            weekly,
            starts_at=datetime(2026, 7, 20, 9, tzinfo=UTC),
            ends_at=datetime(2026, 7, 20, 10, tzinfo=UTC),
            channel="virtual",
            location="",
        )
        self.assertEqual(valid_weekly["slot_indices"], [0, 1])
        self.assertEqual(valid_weekly["location"], "Online")

        midnight = Event.objects.create(
            code="MIDNIGHT",
            name="Midnight",
            organizer=self.organizer,
            timezone="UTC",
            days=[1],
            start_minutes=23 * 60,
            end_minutes=0,
            slot_minutes=30,
            spans_next_day=True,
        )
        normalized_midnight = normalize_final_time(
            midnight,
            starts_at=datetime(2026, 7, 20, 23, tzinfo=UTC),
            ends_at=datetime(2026, 7, 21, 0, tzinfo=UTC),
            channel="inperson",
            location="",
        )
        self.assertEqual(normalized_midnight["slot_indices"], [0, 1])
        self.assertEqual(normalized_midnight["location"], "Location to be confirmed")
        overnight = Event.objects.create(
            code="OVERNIGHT",
            name="Overnight",
            organizer=self.organizer,
            mode="virtual",
            timezone="UTC",
            days=[1],
            start_minutes=23 * 60,
            end_minutes=2 * 60,
            slot_minutes=30,
            spans_next_day=True,
        )
        overnight_result = normalize_final_time(
            overnight,
            starts_at=datetime(2026, 7, 21, 0, 30, tzinfo=UTC),
            ends_at=datetime(2026, 7, 21, 1, 30, tzinfo=UTC),
            channel="virtual",
            location="",
        )
        self.assertEqual(overnight_result["slot_indices"], [3, 4])

        spring = Event.objects.create(
            code="SPRINGDST",
            name="Spring",
            organizer=self.organizer,
            timezone="America/Los_Angeles",
            day_selection_type="specific_dates",
            specific_dates=["2026-03-08"],
            start_minutes=1 * 60,
            end_minutes=4 * 60,
            slot_minutes=30,
        )
        spring_groups = build_event_slot_groups(spring)
        self.assertEqual(len(spring_groups[0].slots), 4)
        self.assertEqual(
            [(slot.local_start, slot.local_end) for slot in spring_groups[0].slots],
            [
                ("01:00", "01:30"),
                ("01:30", "03:00"),
                ("03:00", "03:30"),
                ("03:30", "04:00"),
            ],
        )
        spring_result = normalize_final_time(
            spring,
            starts_at=datetime(2026, 3, 8, 9, tzinfo=UTC),
            ends_at=datetime(2026, 3, 8, 10, tzinfo=UTC),
            channel="inperson",
            location="",
        )
        self.assertEqual(spring_result["slot_indices"], [0, 1])

        fall = Event.objects.create(
            code="FALLDST",
            name="Fall",
            organizer=self.organizer,
            timezone="America/Los_Angeles",
            day_selection_type="specific_dates",
            specific_dates=["2026-11-01"],
            start_minutes=0,
            end_minutes=3 * 60,
            slot_minutes=30,
        )
        fall_slots = build_event_slot_groups(fall)[0].slots
        self.assertEqual(len(fall_slots), 8)
        repeated_one_am = [slot for slot in fall_slots if slot.local_start == "01:00"]
        self.assertEqual([slot.start_offset for slot in repeated_one_am], ["-07:00", "-08:00"])
        fallback_result = normalize_final_time(
            fall,
            starts_at=datetime.fromisoformat("2026-11-01T01:00:00-07:00"),
            ends_at=datetime.fromisoformat("2026-11-01T01:00:00-08:00"),
            channel="inperson",
            location="",
        )
        self.assertEqual(fallback_result["slot_indices"], [2, 3])

        weekly_spring = Event.objects.create(
            code="WEEKSPRING",
            name="Weekly spring",
            organizer=self.organizer,
            timezone="America/Los_Angeles",
            days=[0],
            start_minutes=60,
            end_minutes=4 * 60,
            slot_minutes=30,
        )
        with self.assertRaisesMessage(FinalizationError, "nonexistent local slot"):
            normalize_final_time(
                weekly_spring,
                starts_at=datetime(2026, 3, 8, 9, tzinfo=UTC),
                ends_at=datetime(2026, 3, 8, 10, tzinfo=UTC),
                channel="inperson",
                location="",
            )

        weekly_fall = Event.objects.create(
            code="WEEKFALL",
            name="Weekly fall",
            organizer=self.organizer,
            timezone="America/Los_Angeles",
            days=[0],
            start_minutes=0,
            end_minutes=3 * 60,
            slot_minutes=30,
        )
        with self.assertRaisesMessage(FinalizationError, "ambiguous local slot"):
            normalize_final_time(
                weekly_fall,
                starts_at=datetime(2026, 11, 1, 7, 30, tzinfo=UTC),
                ends_at=datetime(2026, 11, 1, 9, 30, tzinfo=UTC),
                channel="inperson",
                location="",
            )

        validate_iana_timezone("Europe/Paris")
        for invalid in ("Mars/Olympus", None):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                validate_iana_timezone(invalid)

        fallback_event = Event.objects.create(
            code="CANCELFALL",
            name="Cancellation fallback",
            organizer=self.organizer,
        )
        fallback_participant = create_member("cancel-fallback@example.com")
        Participant.objects.create(
            event=fallback_event,
            member=fallback_participant,
            participant_name="Cancellation Fallback",
            availability_inperson=stored([0] * 80),
            availability_virtual=stored([0] * 80),
        )
        FinalMeeting.objects.create(
            event=fallback_event,
            starts_at=datetime(2026, 7, 20, 9, tzinfo=UTC),
            ends_at=datetime(2026, 7, 20, 10, tzinfo=UTC),
            timezone="UTC",
            channel="inperson",
            location="Room",
            calendar_uid=f"final-{fallback_event.event_id}@releviz",
            confirmed_by=self.organizer,
            confirmed_at=timezone.now(),
        )
        fallback_jobs = cancel_active_final_meeting(fallback_event)
        self.assertEqual([job.recipient for job in fallback_jobs], [fallback_participant.email])

    @override_settings(FRONTEND_URL="https://app.example.com")
    def test_calendar_content_is_stable_and_timezone_explicit(self):
        normalized = self.normalized()
        EventInvitation.objects.create(
            event=self.event,
            email="calendar-attendee@example.com",
            invited_by=self.organizer,
        )
        result = confirm_final_meeting(
            event_code=self.event.code,
            organizer=self.organizer,
            expected_version=1,
            idempotency_key=uuid.uuid4(),
            starts_at=normalized["starts_at"],
            ends_at=normalized["ends_at"],
            channel="inperson",
            location="Room; 101",
        )
        meeting = result["meeting"]
        attachment = final_meeting_ics(self.event, meeting)
        self.assertEqual(attachment.filename, "releviz-FINALDOM-final.ics")
        self.assertIn("METHOD:REQUEST", attachment.content)
        self.assertIn(f"UID:{meeting.calendar_uid}", attachment.content)
        self.assertIn("SEQUENCE:0", attachment.content)
        self.assertIn("X-WR-TIMEZONE:America/Los_Angeles", attachment.content)
        self.assertIn("DTSTART:20260720T160000Z", attachment.content)
        self.assertIn("DTEND:20260720T180000Z", attachment.content)
        self.assertIn("LOCATION:Room\\; 101", attachment.content)
        self.assertIn("https://app.example.com/event?code=FINALDOM", attachment.content)
        confirmation_content = result["jobs"][0].attachments[0]["content"]
        self.assertIn("ORGANIZER:mailto:final-organizer@example.com", confirmation_content)
        self.assertIn(
            "ATTENDEE;RSVP=TRUE:mailto:",
            confirmation_content,
        )
        self.event.name = "Long\r\n" + ("é" * 100)
        folded = final_meeting_ics(self.event, meeting)
        physical_lines = folded.content.split("\r\n")
        self.assertTrue(any(line.startswith(" ") for line in physical_lines))
        self.assertTrue(all(len(line.encode("utf-8")) <= 75 for line in physical_lines))

        no_email = create_member("calendar-no-email@example.com")
        ContactEmail.objects.filter(member=no_email).delete()
        no_email.email = ""
        no_email.save(update_fields=["email"])
        self.event.organizer = no_email
        without_organizer = final_meeting_ics(self.event, meeting)
        self.assertNotIn("ORGANIZER:", without_organizer.content)


class FinalizationApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("final-api-organizer@example.com", "Org", "Owner")
        self.participant = create_member("final-api-participant@example.com", "Pat", "Person")
        self.other = create_member("final-api-other@example.com", "Other", "Person")
        self.event = Event.objects.create(
            code="FINALAPI",
            name="Final API",
            organizer=self.organizer,
            mode="mixed",
            location="Main Room",
            timezone="UTC",
            start_minutes=9 * 60,
            end_minutes=12 * 60,
            slot_minutes=30,
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
            status=Event.Status.OPEN,
            opened_at=timezone.now(),
        )
        self.participant_record = Participant.objects.create(
            event=self.event,
            member=self.participant,
            participant_name=self.participant.display_name(),
            availability_inperson=stored([1, 1, 1, 1, 0, 0]),
            availability_virtual=stored([1, 1, 0.5, 0.5, 0, 0]),
            submitted=True,
        )
        EventInvitation.objects.create(
            event=self.event,
            email=self.participant.email,
            member=self.participant,
            invited_by=self.organizer,
            status=EventInvitation.Status.SUBMITTED,
        )
        self.payload = {
            "startsAt": "2026-07-20T09:00:00+00:00",
            "endsAt": "2026-07-20T11:00:00+00:00",
            "channel": "inperson",
            "location": "Main Room",
        }

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def confirm(self, **changes):
        payload = {
            **self.payload,
            "expectedVersion": self.event.version,
            "idempotencyKey": str(uuid.uuid4()),
            **changes,
        }
        return self.client.put(
            f"/api/events/finalization?code={self.event.code}",
            payload,
            format="json",
        )

    def test_preview_and_confirmation_validation_permissions_and_delivery(self):
        self.authenticate(self.other)
        self.assertEqual(
            self.client.post("/api/events/finalization/preview", {}, format="json").status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/api/events/finalization/preview?code=NOPE",
                self.payload,
                format="json",
            ).status_code,
            404,
        )
        denied = self.client.post(
            f"/api/events/finalization/preview?code={self.event.code}",
            self.payload,
            format="json",
        )
        self.assertEqual(denied.status_code, 403)

        self.authenticate(self.organizer)
        for payload in (
            {**self.payload, "startsAt": None},
            {**self.payload, "startsAt": "bad"},
            {**self.payload, "startsAt": "2026-07-20T09:00:00"},
            {**self.payload, "endsAt": None},
            {**self.payload, "channel": "phone"},
        ):
            with self.subTest(payload=payload):
                response = self.client.post(
                    f"/api/events/finalization/preview?code={self.event.code}",
                    payload,
                    format="json",
                )
                self.assertEqual(response.status_code, 400)

        preview = self.client.post(
            f"/api/events/finalization/preview?code={self.event.code}",
            self.payload,
            format="json",
        )
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.data["attendance"]["availableParticipantTotal"], 1)
        self.assertEqual(preview.data["proposedMeeting"]["timezone"], "UTC")

        self.assertEqual(
            self.client.put("/api/events/finalization", {}, format="json").status_code,
            400,
        )
        self.assertEqual(
            self.client.put(
                f"/api/events/finalization?code={self.event.code}",
                self.payload,
                format="json",
            ).status_code,
            428,
        )
        self.assertEqual(self.confirm(expectedVersion=True).status_code, 428)
        self.assertEqual(self.confirm(idempotencyKey="bad").status_code, 400)
        self.assertEqual(self.confirm(startsAt=None).status_code, 400)
        self.assertEqual(self.confirm(endsAt=None).status_code, 400)

        confirmed = self.confirm()
        self.assertEqual(confirmed.status_code, 200)
        self.assertFalse(confirmed.data["idempotent"])
        self.assertEqual(confirmed.data["event"]["status"], "finalized")
        self.assertEqual(confirmed.data["delivery"]["sent"], 1)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("METHOD:REQUEST", mail.outbox[0].attachments[0][1])
        self.assertEqual(
            EmailMessageLog.objects.get(
                message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION
            ).delivery_job_id,
            EmailDeliveryJob.objects.get().pk,
        )

        self.event.refresh_from_db()
        key = str(FinalizationRequest.objects.first().idempotency_key)
        repeated = self.confirm(expectedVersion=1, idempotencyKey=key)
        self.assertEqual(repeated.status_code, 200)
        self.assertTrue(repeated.data["idempotent"])
        self.assertEqual(EmailDeliveryJob.objects.count(), 1)

        changed = self.confirm(
            expectedVersion=self.event.version,
            startsAt="2026-07-20T10:00:00+00:00",
            endsAt="2026-07-20T11:00:00+00:00",
        )
        self.assertEqual(changed.status_code, 409)

    def test_finalization_survives_provider_failure_and_locks_configuration(self):
        self.authenticate(self.organizer)
        with patch(
            "apps.messaging.services.EmailMultiAlternatives.send",
            side_effect=TimeoutError("provider timeout"),
        ):
            confirmed = self.confirm()
        self.assertEqual(confirmed.status_code, 200)
        self.assertEqual(confirmed.data["delivery"]["retry"], 1)
        job = EmailDeliveryJob.objects.get()
        self.assertEqual(job.status, EmailDeliveryJob.Status.RETRY)
        self.assertIn("provider timeout", job.last_error)

        participant_url = (
            f"/api/events/participants/update?code={self.event.code}"
            f"&participantId={self.participant.pk}"
        )
        self.assertEqual(
            self.client.delete(participant_url, format="json").status_code,
            409,
        )
        self.assertEqual(
            self.client.put(
                f"/api/events/participants/update/unhide?code={self.event.code}"
                f"&participantId={self.participant.pk}",
                {},
                format="json",
            ).status_code,
            409,
        )
        self.assertEqual(
            self.client.put(
                f"/api/events/weights?code={self.event.code}",
                {"weights": []},
                format="json",
            ).status_code,
            409,
        )
        self.assertEqual(
            self.client.post(
                f"/api/events/invitations?code={self.event.code}",
                {"emails": ["new@example.com"]},
                format="json",
            ).status_code,
            409,
        )
        self.assertEqual(
            self.client.post(
                f"/api/events/reminders?code={self.event.code}",
                {},
                format="json",
            ).status_code,
            409,
        )

    def test_reopen_cancels_calendar_and_reconfirmation_keeps_uid(self):
        self.authenticate(self.organizer)
        confirmed = self.confirm()
        uid = confirmed.data["finalMeeting"]["calendarUid"]
        finalized_version = confirmed.data["event"]["version"]
        with self.captureOnCommitCallbacks(execute=True):
            reopened = self.client.put(
                f"/api/events/lifecycle?code={self.event.code}",
                {
                    "status": "open",
                    "expectedVersion": finalized_version,
                    "responseDeadline": (timezone.now() + timedelta(days=1)).isoformat(),
                },
                format="json",
            )
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.data["event"]["status"], "open")
        self.assertIsNone(reopened.data["event"]["finalMeeting"])
        meeting = FinalMeeting.objects.get(event=self.event)
        self.assertFalse(meeting.active)
        self.assertEqual(meeting.calendar_sequence, 1)
        cancellation = EmailDeliveryJob.objects.get(
            message_type=EmailMessageLog.MessageType.FINAL_CANCELLATION
        )
        self.assertEqual(cancellation.status, EmailDeliveryJob.Status.SENT)
        self.assertIn("METHOD:CANCEL", cancellation.attachments[0]["content"])

        self.event.refresh_from_db()
        reconfirmed = self.confirm(
            expectedVersion=self.event.version,
            startsAt="2026-07-20T10:00:00+00:00",
            endsAt="2026-07-20T11:00:00+00:00",
        )
        self.assertEqual(reconfirmed.status_code, 200)
        self.assertEqual(reconfirmed.data["finalMeeting"]["calendarUid"], uid)
        self.assertEqual(reconfirmed.data["finalMeeting"]["calendarSequence"], 2)

    def test_finalization_detail_and_calendar_authorization(self):
        self.authenticate(self.organizer)
        for path in (
            "/api/events/finalization",
            "/api/events/finalization/calendar",
        ):
            self.assertEqual(self.client.get(path).status_code, 400)
            self.assertEqual(self.client.get(f"{path}?code=NOPE").status_code, 404)
        self.assertEqual(
            self.client.get(f"/api/events/finalization?code={self.event.code}").status_code,
            404,
        )
        self.assertEqual(
            self.client.get(
                f"/api/events/finalization/calendar?code={self.event.code}"
            ).status_code,
            404,
        )

        self.confirm()
        details = self.client.get(f"/api/events/finalization?code={self.event.code}")
        self.assertEqual(details.status_code, 200)
        self.assertIn("attendance", details.data["finalMeeting"])
        calendar = self.client.get(f"/api/events/finalization/calendar?code={self.event.code}")
        self.assertEqual(calendar.status_code, 200)
        self.assertEqual(calendar["Cache-Control"], "private, no-store")
        self.assertIn("text/calendar", calendar["Content-Type"])
        self.assertIn("BEGIN:VCALENDAR", calendar.content.decode())

        self.authenticate(self.other)
        self.assertEqual(
            self.client.get(f"/api/events/finalization?code={self.event.code}").status_code,
            403,
        )
        self.assertEqual(
            self.client.get(
                f"/api/events/finalization/calendar?code={self.event.code}"
            ).status_code,
            403,
        )
        EventInvitation.objects.create(
            event=self.event,
            email=self.other.email,
            invited_by=self.organizer,
        )
        invited_calendar = self.client.get(
            f"/api/events/finalization/calendar?code={self.event.code}"
        )
        self.assertEqual(invited_calendar.status_code, 200)

        FinalMeeting.objects.filter(event=self.event).update(active=False)
        self.assertEqual(
            self.client.get(
                f"/api/events/finalization/calendar?code={self.event.code}"
            ).status_code,
            404,
        )

    def test_event_creation_timezone_validation_and_preview_finalized_state(self):
        self.authenticate(self.organizer)
        invalid = self.client.post(
            "/api/events",
            {"name": "Invalid zone", "timezone": "Moon/Base"},
            format="json",
        )
        self.assertEqual(invalid.status_code, 400)
        created = self.client.post(
            "/api/events",
            {"name": "Paris", "timezone": "Europe/Paris"},
            format="json",
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.data["event"]["timezone"], "Europe/Paris")

        self.confirm()
        preview = self.client.post(
            f"/api/events/finalization/preview?code={self.event.code}",
            self.payload,
            format="json",
        )
        self.assertEqual(preview.status_code, 409)
