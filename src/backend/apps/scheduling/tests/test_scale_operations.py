import uuid
from datetime import UTC, datetime, timedelta

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.messaging.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import (
    Event,
    EventInvitation,
    EventResultInvalidation,
    Participant,
    ScheduleEditRecord,
    UserEvent,
)
from apps.scheduling.result_snapshots import flush_event_result_invalidations


class ScaleOperationApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("scale-owner@example.com", "Scale", "Owner")
        self.event = Event.objects.create(
            code="SCALEOPS",
            name="Scale operations",
            organizer=self.organizer,
            status=Event.Status.DRAFT,
            access_mode="invite_only",
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            slot_minutes=30,
            meeting_duration_minutes=30,
            days=[1],
            timezone="UTC",
        )
        UserEvent.objects.create(
            member=self.organizer,
            event=self.event,
            role="organizer",
        )
        self.authenticate(self.organizer)

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def import_roster(self, rows: list[tuple[str, str]]):
        content = "name,email\n" + "\n".join(f"{name},{email}" for name, email in rows)
        preview = self.client.post(
            f"/events/roster-imports?code={self.event.code}",
            {"sourceType": "paste", "pastedText": content},
            format="json",
        )
        self.assertEqual(preview.status_code, 201, preview.data)
        committed = self.client.post(
            f"/events/roster-imports/{preview.data['import']['id']}/commit?code={self.event.code}",
            {"mode": "merge", "idempotencyKey": str(uuid.uuid4())},
            format="json",
        )
        self.assertEqual(committed.status_code, 201, committed.data)
        self.event.refresh_from_db()
        return committed

    def launch(self, *, key=None, **extra):
        return self.client.post(
            f"/events/launch?code={self.event.code}",
            {
                "expectedVersion": self.event.version,
                "idempotencyKey": str(key or uuid.uuid4()),
                **extra,
            },
            format="json",
        )

    def test_invite_only_access_and_open_link_capacity(self):
        invited = create_member("invited-scale@example.com", "Invited", "Person")
        outsider = create_member("outsider-scale@example.com", "Outside", "Person")
        self.event.status = Event.Status.OPEN
        self.event.opened_at = timezone.now()
        self.event.save(update_fields=["status", "opened_at", "updated_at"])
        EventInvitation.objects.create(
            event=self.event,
            email="invited-scale@example.com",
            member=invited,
            invited_by=self.organizer,
        )

        self.authenticate(outsider)
        hidden = self.client.get(f"/events?code={self.event.code}")
        self.assertEqual(hidden.status_code, 404)
        denied = self.client.post(f"/events/participants?code={self.event.code}")
        self.assertEqual(denied.status_code, 403)

        self.authenticate(invited)
        visible = self.client.get(f"/events?code={self.event.code}")
        self.assertEqual(visible.status_code, 200)
        joined = self.client.post(f"/events/participants?code={self.event.code}")
        self.assertEqual(joined.status_code, 201)

        open_event = Event.objects.create(
            code="OPENLIMIT",
            name="Open link capacity",
            organizer=self.organizer,
            status=Event.Status.OPEN,
            access_mode="open_link",
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            slot_minutes=30,
            meeting_duration_minutes=30,
            days=[1],
        )
        existing = create_member("existing-scale@example.com", "Existing", "Person")
        Participant.objects.create(
            event=open_event,
            member=existing,
            participant_name=existing.display_name(),
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )
        self.authenticate(outsider)
        with override_settings(EVENT_MAX_PARTICIPANTS=1):
            capped = self.client.post(f"/events/participants?code={open_event.code}")
        self.assertEqual(capped.status_code, 409)

    def test_organizer_can_fill_temporary_schedule_after_deadline_and_edit_is_audited(self):
        self.import_roster([("Temporary", "temporary-scale@example.com")])
        participant = self.event.participants.select_related("member").get()
        self.event.status = Event.Status.CLOSED
        self.event.response_deadline = timezone.now() - timedelta(days=1)
        self.event.closed_at = timezone.now()
        self.event.save(update_fields=["status", "response_deadline", "closed_at", "updated_at"])
        previous_revision = self.event.results_revision

        updated = self.client.put(
            (
                f"/events/participants/update?code={self.event.code}"
                f"&participantId={participant.member_id}"
            ),
            {
                "availabilityInperson": [1, 1],
                "availabilityVirtual": [0, 0],
                "submitted": 1,
                "expectedVersion": participant.version,
            },
            format="json",
        )
        self.assertEqual(updated.status_code, 200, updated.data)
        participant.refresh_from_db()
        self.assertEqual(
            EventResultInvalidation.objects.filter(
                event=self.event,
                processed_at__isnull=True,
            ).count(),
            1,
        )
        flush_event_result_invalidations(self.event)
        self.event.refresh_from_db()
        self.assertTrue(participant.submitted)
        self.assertEqual(self.event.results_revision, previous_revision + 1)
        audit = ScheduleEditRecord.objects.get(participant=participant)
        self.assertEqual(audit.actor, self.organizer)
        self.assertEqual(audit.source, ScheduleEditRecord.Source.ORGANIZER)
        self.assertEqual(audit.action, ScheduleEditRecord.Action.SUBMIT)
        self.assertEqual(audit.participant_version, participant.version)

        participant.member.access_level = "full"
        participant.member.save(update_fields=["access_level"])
        forbidden = self.client.put(
            (
                f"/events/participants/update?code={self.event.code}"
                f"&participantId={participant.member_id}"
            ),
            {
                "availabilityInperson": [0, 0],
                "submitted": 0,
                "expectedVersion": participant.version,
            },
            format="json",
        )
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(forbidden.data["errorCode"], "organizer_edit_full_account")

    def test_launch_is_atomic_idempotent_and_delivery_failures_can_be_retried(self):
        self.import_roster(
            [
                ("One", "launch-one@example.com"),
                ("Two", "launch-two@example.com"),
            ]
        )
        key = uuid.uuid4()
        selected = self.event.participants.order_by("created_at").first()
        selection = {"participantIds": [str(selected.pk)]}
        launched = self.launch(key=key, selection=selection)
        self.assertEqual(launched.status_code, 202, launched.data)
        self.event.refresh_from_db()
        self.assertEqual(self.event.status, Event.Status.OPEN)
        request_id = launched.data["deliveryRequest"]["id"]
        delivery_request = EmailDeliveryRequest.objects.get(pk=request_id)
        self.assertEqual(delivery_request.operation, EmailDeliveryRequest.Operation.INVITATION)
        self.assertEqual(delivery_request.jobs.count(), 1)
        self.assertEqual(
            delivery_request.jobs.filter(status=EmailDeliveryJob.Status.PENDING).count(),
            1,
        )
        self.assertEqual(EmailMessageLog.objects.count(), 0)

        progress = self.client.get(f"/events/delivery-requests/{request_id}")
        self.assertEqual(progress.status_code, 200)
        self.assertEqual(progress.data["deliveryRequest"]["delivery"]["pending"], 1)

        failed_job = delivery_request.jobs.first()
        failed_job.status = EmailDeliveryJob.Status.PERMANENT_FAILURE
        failed_job.attempt_count = failed_job.max_attempts
        failed_job.last_error = "provider rejected recipient"
        failed_job.save(update_fields=["status", "attempt_count", "last_error", "updated_at"])
        retried = self.client.post(f"/events/delivery-requests/{request_id}", {}, format="json")
        self.assertEqual(retried.status_code, 202)
        self.assertEqual(retried.data["retried"], 1)
        failed_job.refresh_from_db()
        self.assertEqual(failed_job.status, EmailDeliveryJob.Status.PENDING)
        self.assertEqual(failed_job.attempt_count, 0)

        replay = self.launch(key=key, selection=selection)
        self.assertEqual(replay.status_code, 202)
        self.assertTrue(replay.data["idempotent"])
        conflict = self.launch(key=key, selection=selection, message="different launch")
        self.assertEqual(conflict.status_code, 409)

    def test_obsolete_invitation_delivery_request_is_canceled_instead_of_retried(self):
        self.import_roster([("Obsolete", "obsolete-delivery@example.com")])
        launched = self.launch()
        self.assertEqual(launched.status_code, 202, launched.data)
        delivery_request = EmailDeliveryRequest.objects.get(
            pk=launched.data["deliveryRequest"]["id"]
        )
        failed_job = delivery_request.jobs.get()
        failed_job.status = EmailDeliveryJob.Status.PERMANENT_FAILURE
        failed_job.attempt_count = failed_job.max_attempts
        failed_job.last_error = "provider rejected recipient"
        failed_job.locked_at = timezone.now()
        failed_job.lock_token = uuid.uuid4()
        failed_job.save(
            update_fields=[
                "status",
                "attempt_count",
                "last_error",
                "locked_at",
                "lock_token",
                "updated_at",
            ]
        )
        self.event.status = Event.Status.CLOSED
        self.event.save(update_fields=["status", "updated_at"])

        retried = self.client.post(
            f"/events/delivery-requests/{delivery_request.pk}",
            {},
            format="json",
        )

        self.assertEqual(retried.status_code, 409, retried.data)
        self.assertEqual(retried.data["retried"], 0)
        self.assertEqual(retried.data["canceled"], 1)
        self.assertIn("no longer current", retried.data["error"])
        self.assertEqual(retried.data["deliveryRequest"]["delivery"]["canceled"], 1)
        failed_job.refresh_from_db()
        self.assertEqual(failed_job.status, EmailDeliveryJob.Status.CANCELED)
        self.assertEqual(
            failed_job.last_error,
            "This delivery request was superseded by the event's current state.",
        )
        self.assertIsNone(failed_job.locked_at)
        self.assertIsNone(failed_job.lock_token)

    def test_launch_selection_is_event_scoped_and_open_link_can_publish_empty(self):
        other_event = Event.objects.create(
            code="OTHERSEL",
            name="Other selection",
            organizer=self.organizer,
        )
        foreign_member = create_member("foreign-selection@example.com", "Foreign", "Person")
        foreign = Participant.objects.create(
            event=other_event,
            member=foreign_member,
            participant_name="Foreign Person",
            availability_inperson=[],
            availability_virtual=[],
        )
        EventInvitation.objects.create(
            event=other_event,
            member=foreign_member,
            email=foreign_member.email,
            invited_by=self.organizer,
        )

        rejected = self.launch(selection={"participantIds": [str(foreign.pk)]})
        self.assertEqual(rejected.status_code, 400, rejected.data)
        self.assertIn("Select at least one", rejected.data["error"])
        self.event.refresh_from_db()
        self.assertEqual(self.event.status, Event.Status.DRAFT)
        self.assertFalse(self.event.email_delivery_requests.exists())

        self.event.access_mode = "open_link"
        self.event.save(update_fields=["access_mode", "updated_at"])
        launched = self.launch()
        self.assertEqual(launched.status_code, 202, launched.data)
        self.assertEqual(launched.data["event"]["status"], Event.Status.OPEN)
        delivery_request = EmailDeliveryRequest.objects.get(
            pk=launched.data["deliveryRequest"]["id"]
        )
        self.assertEqual(delivery_request.recipient_count, 0)
        self.assertEqual(delivery_request.created_job_count, 0)
        self.assertEqual(delivery_request.jobs.count(), 0)

    def test_final_request_and_reopen_cancellation_are_trackable_and_calendar_downloads(self):
        target_date = (timezone.now() + timedelta(days=2)).date()
        self.event.day_selection_type = "specific_dates"
        self.event.specific_dates = [target_date.isoformat()]
        self.event.days = []
        self.event.save(
            update_fields=["day_selection_type", "specific_dates", "days", "updated_at"]
        )
        self.import_roster([("Final", "final-scale@example.com")])
        launched = self.launch()
        self.assertEqual(launched.status_code, 202)
        participant = self.event.participants.get()
        participant.availability_inperson = [1, 1]
        participant.submitted = True
        participant.save(update_fields=["availability_inperson", "submitted", "updated_at"])
        invitation = self.event.invitations.get()
        invitation.first_sent_at = timezone.now()
        invitation.save(update_fields=["first_sent_at", "updated_at"])
        self.event.refresh_from_db()

        starts_at = datetime.combine(target_date, datetime.min.time(), tzinfo=UTC) + timedelta(
            hours=9
        )
        ends_at = starts_at + timedelta(minutes=30)
        confirmed = self.client.put(
            f"/events/finalization?code={self.event.code}",
            {
                "startsAt": starts_at.isoformat(),
                "endsAt": ends_at.isoformat(),
                "channel": "inperson",
                "location": "Room 100",
                "expectedVersion": self.event.version,
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(confirmed.status_code, 202, confirmed.data)
        confirmation_request = EmailDeliveryRequest.objects.get(
            pk=confirmed.data["deliveryRequestId"]
        )
        self.assertEqual(
            confirmation_request.operation,
            EmailDeliveryRequest.Operation.FINAL_CONFIRMATION,
        )
        self.assertEqual(confirmation_request.jobs.count(), 1)
        confirmation_request.jobs.update(
            status=EmailDeliveryJob.Status.SENT,
            sent_at=timezone.now(),
        )

        calendar = self.client.get(f"/events/finalization/calendar?code={self.event.code}")
        self.assertEqual(calendar.status_code, 200)
        self.assertIn("METHOD:REQUEST", calendar.content.decode())

        self.event.refresh_from_db()
        reopened = self.client.put(
            f"/events/lifecycle?code={self.event.code}",
            {
                "status": "open",
                "expectedVersion": self.event.version,
                "responseDeadline": None,
            },
            format="json",
        )
        self.assertEqual(reopened.status_code, 202, reopened.data)
        cancellation_request = EmailDeliveryRequest.objects.get(
            pk=reopened.data["cancellationDeliveryRequestId"]
        )
        self.assertEqual(
            cancellation_request.operation,
            EmailDeliveryRequest.Operation.FINAL_CANCELLATION,
        )
        self.assertEqual(cancellation_request.jobs.count(), 1)
        cancellation = cancellation_request.jobs.get()
        self.assertIn("METHOD:CANCEL", cancellation.attachments[0]["content"])

    def test_launch_queues_one_thousand_invitations_without_sending_them(self):
        rows = [(f"Person {index}", f"person-{index}@example.com") for index in range(1000)]
        self.import_roster(rows)

        launched = self.launch()

        self.assertEqual(launched.status_code, 202, launched.data)
        delivery_request = EmailDeliveryRequest.objects.get(
            pk=launched.data["deliveryRequest"]["id"]
        )
        self.assertEqual(delivery_request.recipient_count, 1000)
        self.assertEqual(delivery_request.jobs.count(), 1000)
        self.assertEqual(
            delivery_request.jobs.filter(status=EmailDeliveryJob.Status.PENDING).count(),
            1000,
        )
        self.assertEqual(EmailMessageLog.objects.count(), 0)
