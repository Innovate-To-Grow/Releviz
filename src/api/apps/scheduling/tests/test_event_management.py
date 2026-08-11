import uuid
from datetime import timedelta
from unittest.mock import patch

from django.db import IntegrityError
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import (
    Event,
    EventDeletionRecord,
    EventDuplicationRequest,
    EventInvitation,
    FinalMeeting,
    Participant,
    UserEvent,
)


class EventManagementApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("event-manager@example.com", "Event", "Manager")
        self.other = create_member("event-other@example.com", "Other", "Member")

    def authenticate(self, member=None):
        member = member or self.organizer
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def event(self, *, code="MANAGE01", **changes):
        values = {
            "code": code,
            "name": "Managed event",
            "organizer": self.organizer,
            "status": Event.Status.OPEN,
            "opened_at": timezone.now(),
            "start_minutes": 9 * 60,
            "end_minutes": 10 * 60,
            "slot_minutes": 30,
            "days": [1],
            "timezone": "UTC",
            "location": "TBD",
        }
        values.update(changes)
        event = Event.objects.create(**values)
        UserEvent.objects.get_or_create(
            member=self.organizer,
            event=event,
            role="organizer",
        )
        return event

    def edit(self, event, payload):
        return self.client.put(
            f"/events?code={event.code}",
            payload,
            format="json",
        )

    def duplicate(self, event, payload):
        return self.client.post(
            f"/events/duplicate?code={event.code}",
            payload,
            format="json",
        )

    def delete(self, event, payload):
        return self.client.delete(
            f"/events?code={event.code}",
            payload,
            format="json",
        )

    def participant(self, event, *, submitted=True):
        return Participant.objects.create(
            event=event,
            member=self.other,
            participant_name="Other Member",
            availability_inperson=[1, 0],
            availability_virtual=[0, 1],
            submitted=submitted,
        )

    def invitation(self, event, *, status=EventInvitation.Status.SUBMITTED):
        return EventInvitation.objects.create(
            event=event,
            email=self.other.email,
            member=self.other,
            invited_by=self.organizer,
            status=status,
            accepted_at=timezone.now(),
        )

    def delivery_job(self, event, *, status=EmailDeliveryJob.Status.PENDING, locked_at=None):
        return EmailDeliveryJob.objects.create(
            idempotency_key=f"event-management:{event.code}:{uuid.uuid4()}",
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient=self.other.email,
            subject="Managed event invitation",
            body="Invitation body",
            message_id=f"<{uuid.uuid4()}@releviz.local>",
            event=event,
            status=status,
            locked_at=locked_at,
            lock_token=uuid.uuid4() if locked_at else None,
        )

    def final_meeting(self, event):
        now = timezone.now()
        return FinalMeeting.objects.create(
            event=event,
            starts_at=now + timedelta(days=1),
            ends_at=now + timedelta(days=1, hours=1),
            timezone=event.timezone,
            channel="inperson",
            location=event.location,
            calendar_uid=f"{uuid.uuid4()}@releviz.local",
            confirmed_by=self.organizer,
            confirmed_at=now,
        )

    def test_creation_avoids_deleted_codes_and_retries_insert_races(self):
        self.authenticate()
        record = EventDeletionRecord.objects.create(
            event_id=uuid.uuid4(),
            code="TOMBSTON",
            organizer=self.organizer,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="f" * 64,
            deleted_version=3,
        )
        self.assertIn("TOMBSTON", str(record))

        with patch(
            "apps.scheduling.event_management.generate_event_code",
            side_effect=["TOMBSTON", "FRESH001"],
        ):
            created = self.client.post("/events", {"name": "Fresh"}, format="json")
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.data["event"]["code"], "FRESH001")

        original_create = Event.objects.create
        attempts = []

        def racing_create(*args, **kwargs):
            if not attempts:
                attempts.append("collision")
                raise IntegrityError("simulated event-code race")
            return original_create(*args, **kwargs)

        with (
            patch(
                "apps.scheduling.event_management._unique_event_code",
                side_effect=["RACE0001", "RACE0002"],
            ),
            patch.object(Event.objects, "create", side_effect=racing_create),
        ):
            raced = self.client.post("/events", {"name": "Race safe"}, format="json")
        self.assertEqual(raced.status_code, 201)
        self.assertEqual(raced.data["event"]["code"], "RACE0002")

        cleared_deadline = self.client.post(
            "/events",
            {"name": "No deadline", "responseDeadline": None},
            format="json",
        )
        self.assertEqual(cleared_deadline.status_code, 201)
        self.assertIsNone(cleared_deadline.data["event"]["responseDeadline"])

        with (
            patch(
                "apps.scheduling.event_management._unique_event_code",
                side_effect=["FAIL0001", "FAIL0002", "FAIL0003"],
            ),
            patch.object(
                Event.objects,
                "create",
                side_effect=IntegrityError("persistent simulated race"),
            ),
        ):
            exhausted = self.client.post(
                "/events",
                {"name": "Cannot insert"},
                format="json",
            )
        self.assertEqual(exhausted.status_code, 500)

        invalid = self.client.post(
            "/events",
            {"name": "Invalid reminder", "reminderHoursBefore": True},
            format="json",
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertIn("must be an integer", invalid.data["error"])

    def test_edit_is_versioned_and_resets_responses_only_after_confirmation(self):
        self.authenticate()
        event = self.event()
        participant = self.participant(event)
        invitation = self.invitation(event)

        self.assertEqual(self.client.put("/events", {}, format="json").status_code, 400)
        self.assertEqual(
            self.client.put(
                "/events?code=UNKNOWN",
                {"expectedVersion": 1},
                format="json",
            ).status_code,
            404,
        )

        self.authenticate(self.other)
        self.assertEqual(
            self.edit(event, {"expectedVersion": event.version, "name": "No access"}).status_code,
            403,
        )
        self.authenticate()
        self.assertEqual(self.edit(event, {"name": "Missing version"}).status_code, 428)
        self.assertEqual(
            self.edit(event, {"expectedVersion": True, "name": "Boolean version"}).status_code,
            428,
        )
        self.assertEqual(
            self.edit(
                event,
                {
                    "expectedVersion": event.version,
                    "resetResponses": "yes",
                },
            ).status_code,
            400,
        )

        no_change = self.edit(event, {"expectedVersion": event.version})
        self.assertEqual(no_change.status_code, 200)
        self.assertTrue(no_change.data["idempotent"])

        renamed = self.edit(
            event,
            {
                "expectedVersion": event.version,
                "name": "Renamed event",
                "location": "Room 4",
                "participantViewPermission": "realtime",
            },
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertFalse(renamed.data["idempotent"])
        self.assertEqual(renamed.data["responsesReset"], 0)
        renamed_version = renamed.data["event"]["version"]
        participant.refresh_from_db()
        self.assertTrue(participant.submitted)
        self.assertEqual(participant.availability_inperson, [1, 0])

        replay = self.edit(
            event,
            {
                "expectedVersion": event.version,
                "name": "Renamed event",
                "location": "Room 4",
                "participantViewPermission": "realtime",
            },
        )
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(replay.data["event"]["version"], renamed_version)

        stale = self.edit(
            event,
            {"expectedVersion": event.version, "name": "Stale overwrite"},
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.data["event"]["name"], "Renamed event")

        reset_required = self.edit(
            event,
            {
                "expectedVersion": renamed_version,
                "endTime": "10:30",
            },
        )
        self.assertEqual(reset_required.status_code, 409)
        self.assertTrue(reset_required.data["requiresResponseReset"])
        self.assertEqual(reset_required.data["participantCount"], 1)

        reset = self.edit(
            event,
            {
                "expectedVersion": renamed_version,
                "endTime": "10:30",
                "resetResponses": True,
            },
        )
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(reset.data["responsesReset"], 1)
        self.assertEqual(reset.data["event"]["slotCount"], 3)
        participant.refresh_from_db()
        invitation.refresh_from_db()
        self.assertEqual(participant.availability_inperson, [0, 0, 0])
        self.assertEqual(participant.availability_virtual, [0, 0, 0])
        self.assertFalse(participant.submitted)
        self.assertEqual(participant.version, 2)
        self.assertEqual(invitation.status, EventInvitation.Status.JOINED)

        past_deadline = self.edit(
            event,
            {
                "expectedVersion": reset.data["event"]["version"],
                "responseDeadline": (timezone.now() - timedelta(minutes=1)).isoformat(),
            },
        )
        self.assertEqual(past_deadline.status_code, 400)

    def test_edit_handles_configuration_modes_and_locked_lifecycle_states(self):
        self.authenticate()
        event = self.event(code="NOPEOPLE")
        changed = self.edit(
            event,
            {
                "expectedVersion": event.version,
                "daySelectionType": "specific_dates",
            },
        )
        self.assertEqual(changed.status_code, 400)
        self.assertIn("specificDates", changed.data["error"])

        dates = self.edit(
            event,
            {
                "expectedVersion": event.version,
                "daySelectionType": "specific_dates",
                "specificDates": ["2026-08-12", "2026-08-11"],
                "startTime": "23:00",
                "endTime": "01:00",
                "slotMinutes": 15,
                "timezone": "Europe/Paris",
            },
        )
        self.assertEqual(dates.status_code, 200)
        self.assertEqual(dates.data["event"]["specificDates"], ["2026-08-11", "2026-08-12"])

        renamed = self.edit(
            event,
            {
                "expectedVersion": dates.data["event"]["version"],
                "name": "Specific-date event",
            },
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.data["event"]["specificDates"], ["2026-08-11", "2026-08-12"])

        weekdays = self.edit(
            event,
            {
                "expectedVersion": renamed.data["event"]["version"],
                "daySelectionType": "days_of_week",
                "mode": "virtual",
            },
        )
        self.assertEqual(weekdays.status_code, 200)
        self.assertEqual(weekdays.data["event"]["days"], [1, 2, 3, 4, 5])
        self.assertEqual(weekdays.data["event"]["location"], "")

        archived = self.event(code="ARCHEDIT", status=Event.Status.ARCHIVED, opened_at=None)
        self.assertEqual(
            self.edit(
                archived,
                {"expectedVersion": archived.version, "name": "Cannot edit"},
            ).status_code,
            400,
        )

        finalized = self.event(code="FINALEDT", status=Event.Status.FINALIZED)
        self.assertEqual(
            self.edit(
                finalized,
                {"expectedVersion": finalized.version, "name": "Cannot edit"},
            ).status_code,
            400,
        )

        closed = self.event(code="MEETING", status=Event.Status.CLOSED)
        self.final_meeting(closed)
        locked = self.edit(
            closed,
            {"expectedVersion": closed.version, "name": "Calendar would be stale"},
        )
        self.assertEqual(locked.status_code, 400)
        self.assertIn("Reopen", locked.data["error"])

    def test_duplicate_is_idempotent_and_copies_only_configuration(self):
        self.authenticate()
        deadline = timezone.now() + timedelta(days=2)
        source = self.event(
            code="COPYFROM",
            name="Planning session",
            mode="mixed",
            location="Room 7",
            participant_view_permission="all_after_submit",
            day_selection_type="specific_dates",
            specific_dates=["2026-09-01"],
            days=[],
            response_deadline=deadline,
            reminders_enabled=False,
            reminder_hours_before=8,
        )
        self.participant(source)
        self.invitation(source)
        self.delivery_job(source)
        key = uuid.uuid4()
        payload = {
            "expectedVersion": source.version,
            "idempotencyKey": str(key),
        }

        self.assertEqual(
            self.client.post("/events/duplicate", {}, format="json").status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/events/duplicate?code=UNKNOWN",
                payload,
                format="json",
            ).status_code,
            404,
        )
        self.authenticate(self.other)
        self.assertEqual(self.duplicate(source, payload).status_code, 403)
        self.authenticate()
        self.assertEqual(
            self.duplicate(source, {"idempotencyKey": str(key)}).status_code,
            428,
        )
        self.assertEqual(
            self.duplicate(
                source,
                {"expectedVersion": source.version, "idempotencyKey": "bad"},
            ).status_code,
            400,
        )
        self.assertEqual(
            self.duplicate(
                source,
                {
                    "expectedVersion": source.version,
                    "idempotencyKey": str(uuid.uuid4()),
                    "name": "",
                },
            ).status_code,
            400,
        )
        self.assertEqual(
            self.duplicate(
                source,
                {
                    "expectedVersion": source.version,
                    "idempotencyKey": str(uuid.uuid4()),
                    "name": "x" * 201,
                },
            ).status_code,
            400,
        )

        created = self.duplicate(source, payload)
        self.assertEqual(created.status_code, 201)
        self.assertFalse(created.data["idempotent"])
        duplicate = Event.objects.get(code=created.data["event"]["code"])
        self.assertEqual(duplicate.status, Event.Status.DRAFT)
        self.assertEqual(duplicate.name, "Planning session (copy)")
        self.assertEqual(duplicate.mode, source.mode)
        self.assertEqual(duplicate.location, source.location)
        self.assertEqual(duplicate.specific_dates, source.specific_dates)
        self.assertEqual(duplicate.response_deadline, deadline)
        self.assertIsNone(duplicate.opened_at)
        self.assertFalse(duplicate.participants.exists())
        self.assertFalse(duplicate.invitations.exists())
        self.assertFalse(duplicate.email_delivery_jobs.exists())
        self.assertTrue(
            UserEvent.objects.filter(
                event=duplicate,
                member=self.organizer,
                role="organizer",
            ).exists()
        )

        replay = self.duplicate(source, payload)
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(replay.data["event"]["code"], duplicate.code)
        request_record = EventDuplicationRequest.objects.get(
            source_event=source,
            idempotency_key=key,
        )
        self.assertIn(source.code, str(request_record))

        conflict = self.duplicate(source, {**payload, "name": "Different copy"})
        self.assertEqual(conflict.status_code, 409)

        stale = self.duplicate(
            source,
            {
                "expectedVersion": source.version + 1,
                "idempotencyKey": str(uuid.uuid4()),
            },
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.data["event"]["code"], source.code)

        custom = self.duplicate(
            source,
            {
                "expectedVersion": source.version,
                "idempotencyKey": str(uuid.uuid4()),
                "name": "September planning",
            },
        )
        self.assertEqual(custom.status_code, 201)
        self.assertEqual(custom.data["event"]["name"], "September planning")

        duplicate.delete()
        deleted_replay = self.duplicate(source, payload)
        self.assertEqual(deleted_replay.status_code, 410)

        long_source = self.event(code="LONGCOPY", name="x" * 200)
        long_copy = self.duplicate(
            long_source,
            {
                "expectedVersion": long_source.version,
                "idempotencyKey": str(uuid.uuid4()),
            },
        )
        self.assertEqual(long_copy.status_code, 201)
        self.assertEqual(len(long_copy.data["event"]["name"]), 200)
        self.assertTrue(long_copy.data["event"]["name"].endswith(" (copy)"))

    def test_delete_is_confirmed_idempotent_and_safe_around_email_delivery(self):
        self.authenticate()
        event = self.event(code="DELETE01")
        participant = self.participant(event)
        invitation = self.invitation(event)
        active_job = self.delivery_job(
            event,
            status=EmailDeliveryJob.Status.PROCESSING,
            locked_at=timezone.now(),
        )
        message_log = EmailMessageLog.objects.create(
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient=self.other.email,
            subject="Invitation",
            status=EmailMessageLog.Status.SENT,
            event=event,
            invitation=invitation,
            delivery_job=active_job,
        )
        key = uuid.uuid4()
        payload = {
            "expectedVersion": event.version,
            "idempotencyKey": str(key),
            "confirmation": event.code,
        }

        self.assertEqual(self.client.delete("/events", {}, format="json").status_code, 400)
        self.assertEqual(
            self.client.delete(
                "/events?code=UNKNOWN",
                payload,
                format="json",
            ).status_code,
            404,
        )
        self.assertEqual(
            self.delete(
                event,
                {
                    "expectedVersion": event.version,
                    "idempotencyKey": "bad",
                    "confirmation": event.code,
                },
            ).status_code,
            400,
        )
        self.authenticate(self.other)
        self.assertEqual(self.delete(event, payload).status_code, 403)
        self.authenticate()
        self.assertEqual(
            self.delete(event, {**payload, "confirmation": "WRONG"}).status_code,
            400,
        )
        self.assertEqual(
            self.delete(event, {**payload, "expectedVersion": event.version + 1}).status_code,
            409,
        )

        busy = self.delete(event, payload)
        self.assertEqual(busy.status_code, 409)
        self.assertTrue(busy.data["retryable"])
        active_job.locked_at = None
        active_job.lock_token = None
        active_job.save(update_fields=["locked_at", "lock_token", "updated_at"])

        with (
            self.assertLogs("apps.scheduling.event_management", level="INFO") as logs,
            self.captureOnCommitCallbacks(execute=True),
        ):
            deleted = self.delete(event, payload)
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(deleted.data["idempotent"])
        self.assertIn("event_deleted", "\n".join(logs.output))
        self.assertFalse(Event.objects.filter(pk=event.pk).exists())
        self.assertFalse(Participant.objects.filter(pk=participant.pk).exists())
        self.assertFalse(EventInvitation.objects.filter(pk=invitation.pk).exists())
        self.assertFalse(EmailDeliveryJob.objects.filter(pk=active_job.pk).exists())
        self.assertFalse(EmailMessageLog.objects.filter(pk=message_log.pk).exists())

        record = EventDeletionRecord.objects.get(code=event.code)
        self.assertEqual(record.event_id, event.event_id)
        self.assertEqual(record.deleted_version, event.version)
        self.assertIn(event.code, str(record))

        replay = self.client.delete(
            f"/events?code={event.code}",
            payload,
            format="json",
        )
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.data["idempotent"])
        changed_replay = self.client.delete(
            f"/events?code={event.code}",
            {**payload, "confirmation": "DIFFERENT"},
            format="json",
        )
        self.assertEqual(changed_replay.status_code, 404)

        collision_key = uuid.uuid4()
        EventDeletionRecord.objects.create(
            event_id=uuid.uuid4(),
            code="OLDDELETE",
            organizer=self.organizer,
            idempotency_key=collision_key,
            request_fingerprint="a" * 64,
            deleted_version=1,
        )
        collision_event = self.event(code="NEWDELETE")
        collision = self.delete(
            collision_event,
            {
                "expectedVersion": collision_event.version,
                "idempotencyKey": str(collision_key),
                "confirmation": collision_event.code,
            },
        )
        self.assertEqual(collision.status_code, 409)
