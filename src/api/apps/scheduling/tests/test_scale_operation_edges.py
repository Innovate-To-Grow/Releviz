import uuid
from datetime import timedelta
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.mail.management.commands.dispatch_email_jobs import Command as EmailWorkerCommand
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.event_management import EventManagementError, parse_event_configuration
from apps.scheduling.finalization import (
    FinalizationError,
    _ensure_final_delivery_request,
)
from apps.scheduling.management.commands.recompute_event_results import (
    Command as ResultWorkerCommand,
)
from apps.scheduling.models import (
    Event,
    EventInvitation,
    EventResultSnapshot,
    FinalMeeting,
    Participant,
    RosterImportBatch,
    RosterImportRow,
    ScheduleEditRecord,
)
from apps.scheduling.operations_views import _calendar_job_sequence, _retryable_job_ids
from apps.scheduling.permissions import (
    can_access_event,
    can_join_event,
    verified_invitation_emails,
)
from apps.scheduling.slots import SlotConfigurationError, validate_minute_configuration
from apps.scheduling.views import organizer_response_write_error


class ScaleOperationEdgeTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("operation-edge-owner@example.com", "Owner", "Edge")
        self.outsider = create_member("operation-edge-outsider@example.com", "Outside", "Edge")
        self.invitee = create_member("operation-edge-invitee@example.com", "Invitee", "Edge")
        self.event = Event.objects.create(
            code="OPSEDGE",
            name="Operation edge cases",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            slot_minutes=30,
        )
        self.participant = Participant.objects.create(
            event=self.event,
            member=self.invitee,
            participant_name="Invitee",
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        EventInvitation.objects.create(
            event=self.event,
            email=self.invitee.email,
            member=self.invitee,
            invited_by=self.organizer,
        )
        self.authenticate(self.organizer)

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def test_legacy_launch_route_is_removed_for_all_request_shapes(self):
        for path, payload in (
            ("/events/launch", {}),
            (f"/events/launch?code={self.event.code}", {"idempotencyKey": "bad"}),
            ("/events/launch?code=MISSING", {"idempotencyKey": str(uuid.uuid4())}),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.post(path, payload, format="json").status_code, 404)

    def test_delivery_request_privacy_missing_and_noop_retry(self):
        missing = uuid.uuid4()
        self.assertEqual(self.client.get(f"/events/delivery-requests/{missing}").status_code, 404)
        self.assertEqual(
            self.client.post(f"/events/delivery-requests/{missing}", {}, format="json").status_code,
            404,
        )
        delivery = EmailDeliveryRequest.objects.create(
            event=self.event,
            requested_by=self.organizer,
            operation=EmailDeliveryRequest.Operation.INVITATION,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="f" * 64,
        )
        self.authenticate(self.outsider)
        self.assertEqual(
            self.client.get(f"/events/delivery-requests/{delivery.pk}").status_code, 404
        )
        self.assertEqual(
            self.client.post(
                f"/events/delivery-requests/{delivery.pk}", {}, format="json"
            ).status_code,
            404,
        )
        self.authenticate(self.organizer)
        retried = self.client.post(f"/events/delivery-requests/{delivery.pk}", {}, format="json")
        self.assertEqual(retried.status_code, 202)
        self.assertEqual(retried.data["retried"], 0)

    def test_calendar_delivery_retry_classifies_current_and_obsolete_jobs(self):
        def delivery_job(key, message_type):
            return EmailDeliveryJob.objects.create(
                idempotency_key=key,
                message_type=message_type,
                recipient=f"{uuid.uuid4()}@example.com",
                subject="Calendar update",
                body="Calendar update",
                message_id=f"<{uuid.uuid4()}@releviz.local>",
                event=self.event,
                status=EmailDeliveryJob.Status.PERMANENT_FAILURE,
            )

        missing_meeting_job = delivery_job(
            f"final-confirmation:{self.event.event_id}:0:missing@example.com",
            EmailMessageLog.MessageType.FINAL_CONFIRMATION,
        )
        confirmation_request = SimpleNamespace(
            operation=EmailDeliveryRequest.Operation.FINAL_CONFIRMATION
        )
        self.assertEqual(
            _retryable_job_ids(
                event=self.event,
                delivery_request=confirmation_request,
                jobs=[missing_meeting_job],
            ),
            ([], [missing_meeting_job.pk]),
        )

        now = timezone.now()
        meeting = FinalMeeting.objects.create(
            event=self.event,
            starts_at=now,
            ends_at=now + timedelta(minutes=30),
            timezone="UTC",
            channel="virtual",
            location="https://example.com/meeting",
            calendar_uid=f"retry-{self.event.event_id}@releviz.local",
            calendar_sequence=2,
            confirmed_by=self.organizer,
            confirmed_at=now,
        )
        current = delivery_job(
            f"final-confirmation:{self.event.event_id}:2:current@example.com",
            EmailMessageLog.MessageType.FINAL_CONFIRMATION,
        )
        stale_sequence = delivery_job(
            f"final-confirmation:{self.event.event_id}:1:stale@example.com",
            EmailMessageLog.MessageType.FINAL_CONFIRMATION,
        )
        malformed = delivery_job(
            "final-confirmation:malformed",
            EmailMessageLog.MessageType.FINAL_CONFIRMATION,
        )
        nonnumeric = delivery_job(
            f"final-confirmation:{self.event.event_id}:not-a-number:bad@example.com",
            EmailMessageLog.MessageType.FINAL_CONFIRMATION,
        )
        wrong_type = delivery_job(
            f"final-confirmation:{self.event.event_id}:2:wrong-type@example.com",
            EmailMessageLog.MessageType.FINAL_CANCELLATION,
        )
        eligible, obsolete = _retryable_job_ids(
            event=self.event,
            delivery_request=confirmation_request,
            jobs=[current, stale_sequence, malformed, nonnumeric, wrong_type],
        )
        self.assertEqual(eligible, [current.pk])
        self.assertEqual(
            obsolete,
            [stale_sequence.pk, malformed.pk, nonnumeric.pk, wrong_type.pk],
        )
        self.assertIsNone(
            _calendar_job_sequence(
                current,
                prefix="final-cancellation",
                event=self.event,
            )
        )

        meeting.active = False
        meeting.calendar_sequence = 3
        meeting.canceled_at = now
        meeting.save(update_fields=["active", "calendar_sequence", "canceled_at", "updated_at"])
        cancellation = delivery_job(
            f"final-cancellation:{self.event.event_id}:3:current@example.com",
            EmailMessageLog.MessageType.FINAL_CANCELLATION,
        )
        eligible, obsolete = _retryable_job_ids(
            event=self.event,
            delivery_request=SimpleNamespace(
                operation=EmailDeliveryRequest.Operation.FINAL_CANCELLATION
            ),
            jobs=[cancellation],
        )
        self.assertEqual(eligible, [cancellation.pk])
        self.assertEqual(obsolete, [])

    def test_scaled_event_configuration_validation_boundaries(self):
        base = {
            "name": "Configuration",
            "startTime": "09:00",
            "endTime": "10:00",
            "slotMinutes": 30,
            "days": [1],
        }
        cases = [
            ({"accessMode": "private"}, "accessMode"),
            ({"meetingDurationMinutes": True}, "must be an integer"),
            ({"meetingDurationMinutes": "bad"}, "must be an integer"),
            ({"meetingDurationMinutes": 14}, "between 15 and 480"),
            ({"meetingDurationMinutes": 500}, "between 15 and 480"),
            ({"meetingDurationMinutes": 45}, "multiple of slotMinutes"),
            ({"meetingDurationMinutes": 90}, "does not fit"),
        ]
        for extra, message in cases:
            with (
                self.subTest(extra=extra),
                self.assertRaisesMessage(EventManagementError, message),
            ):
                parse_event_configuration({**base, **extra})

        invalid_slot_event = Event(start_minutes=0, end_minutes=60, slot_minutes=10)
        with self.assertRaisesMessage(SlotConfigurationError, "15 or 30"):
            validate_minute_configuration(invalid_slot_event)

    def test_access_paths_and_organizer_edit_guards(self):
        self.assertTrue(can_access_event(self.event, self.invitee))
        self.assertTrue(can_join_event(self.event, self.invitee))
        self.event.access_mode = "open_link"
        self.assertTrue(can_access_event(self.event, self.outsider))
        self.assertTrue(can_join_event(self.event, self.outsider))

        original_email = self.invitee.email
        self.invitee.email = ""
        self.assertEqual(verified_invitation_emails(self.invitee), {original_email})

        self.assertIn(
            "archived",
            organizer_response_write_error(SimpleNamespace(status=Event.Status.ARCHIVED)),
        )
        finalized = SimpleNamespace(
            status=Event.Status.ACTIVE,
            final_meeting=SimpleNamespace(active=True),
        )
        self.assertIn("Reopen", organizer_response_write_error(finalized))

    def test_final_delivery_request_rejects_idempotency_fingerprint_conflicts(self):
        key = uuid.uuid4()
        record = _ensure_final_delivery_request(
            event=self.event,
            requested_by=self.organizer,
            operation=EmailDeliveryRequest.Operation.FINAL_CONFIRMATION,
            idempotency_key=key,
            request_fingerprint="a" * 64,
            jobs=[],
            created_job_count=0,
        )
        self.assertEqual(record.request_fingerprint, "a" * 64)
        with self.assertRaisesMessage(FinalizationError, "different details"):
            _ensure_final_delivery_request(
                event=self.event,
                requested_by=self.organizer,
                operation=EmailDeliveryRequest.Operation.FINAL_CONFIRMATION,
                idempotency_key=key,
                request_fingerprint="b" * 64,
                jobs=[],
                created_job_count=0,
            )

    def test_worker_commands_watch_cleanup_and_new_model_strings(self):
        batch = RosterImportBatch.objects.create(
            event=self.event,
            created_by=self.organizer,
            source_type=RosterImportBatch.SourceType.PASTE,
            expires_at=self.event.created_at,
        )
        RosterImportRow.objects.create(
            batch=batch,
            worksheet="Paste",
            row_number=1,
            raw_values=["name", "email"],
        )
        cleanup_output = StringIO()
        call_command("cleanup_roster_imports", stdout=cleanup_output)
        self.assertIn("Expired 1", cleanup_output.getvalue())
        batch.refresh_from_db()
        self.assertEqual(batch.status, RosterImportBatch.Status.EXPIRED)

        result_command = ResultWorkerCommand()
        result_command._request_stop(None, None)
        self.assertTrue(result_command.stop_event.is_set())
        result_command.stop_event.clear()
        result_output = StringIO()
        result_command.stdout = result_output

        def stop_after_wait(_seconds):
            result_command.stop_event.set()

        with (
            patch(
                "apps.scheduling.management.commands.recompute_event_results.recompute_due_event_results",
                return_value={"attempted": 0, "published": 0, "failed": 0, "skipped": 0},
            ) as recompute,
            patch(
                "apps.scheduling.management.commands.recompute_event_results.signal.getsignal",
                return_value="old-handler",
            ),
            patch(
                "apps.scheduling.management.commands.recompute_event_results.signal.signal"
            ) as set_signal,
            patch.object(result_command.stop_event, "wait", side_effect=stop_after_wait),
        ):
            result_command.handle(
                limit=1,
                poll_interval=0.1,
                event_code="",
                watch=True,
                no_retry_failed=True,
            )
        recompute.assert_called_once_with(limit=1, retry_failed=False)
        self.assertEqual(set_signal.call_count, 4)
        self.assertIn("attempted=0", result_output.getvalue())

        once_command = ResultWorkerCommand()
        once_command.stdout = StringIO()
        with patch(
            "apps.scheduling.management.commands.recompute_event_results.recompute_due_event_results",
            return_value={"attempted": 0, "published": 0, "failed": 0, "skipped": 0},
        ) as recompute_once:
            once_command.handle(
                limit=1,
                poll_interval=0.1,
                event_code="",
                watch=False,
                no_retry_failed=False,
            )
        recompute_once.assert_called_once_with(limit=1, retry_failed=True)

        email_command = EmailWorkerCommand()
        email_command._request_stop(None, None)
        self.assertTrue(email_command.stop_event.is_set())

        snapshot = EventResultSnapshot.objects.create(event=self.event)
        edit = ScheduleEditRecord.objects.create(
            event=self.event,
            participant=self.participant,
            actor=self.organizer,
            source=ScheduleEditRecord.Source.ORGANIZER,
            action=ScheduleEditRecord.Action.DRAFT,
            participant_version=1,
        )
        self.assertIn(self.event.code, str(snapshot))
        self.assertIn(str(self.participant.pk), str(edit))
