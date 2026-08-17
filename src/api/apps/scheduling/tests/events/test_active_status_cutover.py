import importlib
import uuid
from datetime import timedelta

from django.apps import apps
from django.db import IntegrityError, connection, transaction
from django.test import TestCase
from django.utils import timezone

from apps.authn.tests.helpers import create_member
from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import Event
from apps.scheduling.services.events import EventManagementError, create_event, duplicate_event
from apps.scheduling.services.events.lifecycle import (
    LifecycleError,
    response_write_error,
    transition_event,
)


class ActiveStatusCoreTests(TestCase):
    def setUp(self):
        self.organizer = create_member("active-status@example.com")
        self.now = timezone.now()

    def event(self, *, status=Event.Status.ACTIVE, deadline=None):
        return Event.objects.create(
            code=f"E{Event.objects.count():07d}",
            name="Active status",
            organizer=self.organizer,
            status=status,
            response_deadline=deadline,
            opened_at=self.now if status == Event.Status.ACTIVE else None,
        )

    def test_create_is_active_and_rejects_legacy_or_expired_status_input(self):
        self.assertEqual(
            {value for value, _label in Event.Status.choices},
            {"active", "finalized", "closed", "archived"},
        )
        event = create_event(organizer=self.organizer, data={"name": "Created active"})
        self.assertEqual(event.status, Event.Status.ACTIVE)
        self.assertIsNotNone(event.opened_at)

        for legacy_status in ("draft", "open", "", None):
            with self.subTest(status=legacy_status):
                with self.assertRaisesMessage(
                    EventManagementError,
                    "New events must start as active",
                ):
                    create_event(
                        organizer=self.organizer,
                        data={"name": "Legacy", "status": legacy_status},
                    )

        with self.assertRaisesMessage(EventManagementError, "future response deadline"):
            create_event(
                organizer=self.organizer,
                data={"name": "Expired", "responseDeadline": self.now.isoformat()},
            )

        with self.assertRaises(IntegrityError), transaction.atomic():
            self.event(status="draft")

    def test_legacy_launch_endpoint_is_removed(self):
        response = self.client.post("/events/launch", {}, content_type="application/json")
        self.assertEqual(response.status_code, 404)

    def test_duplicate_is_active_and_drops_an_expired_deadline(self):
        source = self.event(deadline=self.now - timedelta(minutes=1))
        result = duplicate_event(
            organizer=self.organizer,
            code=source.code,
            data={"expectedVersion": source.version, "idempotencyKey": str(uuid.uuid4())},
        )
        self.assertEqual(result.event.status, Event.Status.ACTIVE)
        self.assertIsNotNone(result.event.opened_at)
        self.assertIsNone(result.event.response_deadline)

    def test_lifecycle_uses_active_and_cancels_only_response_email_jobs_on_close(self):
        event = self.event()
        invitation = EmailDeliveryJob.objects.create(
            idempotency_key="close-invitation",
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient="person@example.com",
            subject="Invitation",
            body="Body",
            message_id="<close-invitation@example.com>",
            event=event,
        )
        reminder = EmailDeliveryJob.objects.create(
            idempotency_key="close-reminder",
            message_type=EmailMessageLog.MessageType.REMINDER,
            recipient="person@example.com",
            subject="Reminder",
            body="Body",
            message_id="<close-reminder@example.com>",
            event=event,
            status=EmailDeliveryJob.Status.RETRY,
        )
        final = EmailDeliveryJob.objects.create(
            idempotency_key="close-final",
            message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION,
            recipient="person@example.com",
            subject="Final",
            body="Body",
            message_id="<close-final@example.com>",
            event=event,
        )

        changed = transition_event(
            event,
            Event.Status.CLOSED,
            response_deadline=None,
            now=self.now,
        )
        event.save(update_fields=changed)
        invitation.refresh_from_db()
        reminder.refresh_from_db()
        final.refresh_from_db()
        self.assertEqual(invitation.status, EmailDeliveryJob.Status.CANCELED)
        self.assertEqual(reminder.status, EmailDeliveryJob.Status.CANCELED)
        self.assertEqual(final.status, EmailDeliveryJob.Status.PENDING)
        self.assertEqual(
            response_write_error(event, now=self.now),
            "Responses cannot change while the event is closed.",
        )

        with self.assertRaisesMessage(LifecycleError, "Invalid event status"):
            transition_event(event, "open", response_deadline=None, now=self.now)
        transition_event(
            event,
            Event.Status.ACTIVE,
            response_deadline=self.now + timedelta(hours=1),
            now=self.now,
        )
        self.assertEqual(event.status, Event.Status.ACTIVE)


class ActiveStatusMigrationGuardTests(TestCase):
    def test_guard_requires_an_empty_event_table(self):
        migration = importlib.import_module("apps.scheduling.migrations.0002_event_status_active")
        schema_editor = connection.schema_editor()
        migration.require_empty_event_table(apps, schema_editor)

        organizer = create_member("migration-guard@example.com")
        Event.objects.create(code="MIGRATE1", name="Migration guard", organizer=organizer)
        with self.assertRaisesMessage(RuntimeError, "Event rows exist"):
            migration.require_empty_event_table(apps, schema_editor)
