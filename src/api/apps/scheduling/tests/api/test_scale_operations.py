import uuid
from datetime import UTC, datetime, timedelta

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    ScheduleEditRecord,
    UserEvent,
)


class ScaleOperationApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("scale-owner@example.com", "Scale", "Owner")
        self.event = Event.objects.create(
            code="SCALEOPS",
            name="Scale operations",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
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

    def test_invite_only_access_and_open_link_capacity(self):
        invited = create_member("invited-scale@example.com", "Invited", "Person")
        outsider = create_member("outsider-scale@example.com", "Outside", "Person")
        self.event.status = Event.Status.ACTIVE
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
            status=Event.Status.ACTIVE,
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

    def test_closed_event_blocks_organizer_entered_temporary_schedule(self):
        self.import_roster([("Temporary", "temporary-scale@example.com")])
        participant = self.event.participants.select_related("member").get()
        self.event.status = Event.Status.CLOSED
        self.event.response_deadline = timezone.now() - timedelta(days=1)
        self.event.closed_at = timezone.now()
        self.event.save(update_fields=["status", "response_deadline", "closed_at", "updated_at"])
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
        self.assertEqual(updated.status_code, 409, updated.data)
        self.assertEqual(updated.data["errorCode"], "participant_response_locked")
        self.assertFalse(ScheduleEditRecord.objects.filter(participant=participant).exists())

    def test_import_auto_invites_and_delivery_failures_can_be_retried(self):
        committed = self.import_roster(
            [
                ("One", "launch-one@example.com"),
                ("Two", "launch-two@example.com"),
            ]
        )
        self.event.refresh_from_db()
        self.assertEqual(self.event.status, Event.Status.ACTIVE)
        request_id = committed.data["deliveryRequest"]["id"]
        delivery_request = EmailDeliveryRequest.objects.get(pk=request_id)
        self.assertEqual(delivery_request.operation, EmailDeliveryRequest.Operation.INVITATION)
        self.assertEqual(delivery_request.jobs.count(), 2)
        self.assertEqual(
            delivery_request.jobs.filter(status=EmailDeliveryJob.Status.PENDING).count(),
            2,
        )
        self.assertEqual(EmailMessageLog.objects.count(), 0)

        progress = self.client.get(f"/events/delivery-requests/{request_id}")
        self.assertEqual(progress.status_code, 200)
        self.assertEqual(progress.data["deliveryRequest"]["delivery"]["pending"], 2)

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

    def test_obsolete_invitation_delivery_request_is_canceled_instead_of_retried(self):
        committed = self.import_roster([("Obsolete", "obsolete-delivery@example.com")])
        delivery_request = EmailDeliveryRequest.objects.get(
            pk=committed.data["deliveryRequest"]["id"]
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

    def test_legacy_launch_route_is_removed(self):
        response = self.client.post(
            f"/events/launch?code={self.event.code}",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 404)

    def test_final_request_and_reopen_cancellation_are_trackable_and_calendar_downloads(self):
        target_date = (timezone.now() + timedelta(days=2)).date()
        self.event.day_selection_type = "specific_dates"
        self.event.specific_dates = [target_date.isoformat()]
        self.event.days = []
        self.event.save(
            update_fields=["day_selection_type", "specific_dates", "days", "updated_at"]
        )
        self.import_roster([("Final", "final-scale@example.com")])
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
                "status": "active",
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

    def test_import_queues_one_thousand_invitations_without_sending_them(self):
        rows = [(f"Person {index}", f"person-{index}@example.com") for index in range(1000)]
        committed = self.import_roster(rows)

        delivery_request = EmailDeliveryRequest.objects.get(
            pk=committed.data["deliveryRequest"]["id"]
        )
        self.assertEqual(delivery_request.recipient_count, 1000)
        self.assertEqual(delivery_request.jobs.count(), 1000)
        self.assertEqual(
            delivery_request.jobs.filter(status=EmailDeliveryJob.Status.PENDING).count(),
            1000,
        )
        self.assertEqual(EmailMessageLog.objects.count(), 0)
