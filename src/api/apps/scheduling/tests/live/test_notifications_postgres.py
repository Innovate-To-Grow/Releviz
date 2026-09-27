"""The change-notification triggers of migration 0011, exercised through real writes.

A second, raw psycopg connection listens on the channel so the tests observe
exactly what a worker's listener would: payloads arrive only when a
transaction commits, once per distinct event, whatever the write path.
"""

from unittest import skipUnless

import psycopg
from django.db import connection, connections, transaction
from django.test import TransactionTestCase

from apps.authn.tests.helpers import create_member
from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import Event, Participant, ParticipantGroup
from apps.scheduling.services.results import recompute_event_results


def open_listener():
    """A raw autocommit connection to the test database, ready to LISTEN.

    Django's connection parameters carry three keys for its own cursor wrapper
    and adapters that psycopg.connect does not accept, so they are dropped.
    """

    params = dict(connections["default"].get_connection_params())
    for key in ("cursor_factory", "context", "prepare_threshold"):
        params.pop(key, None)
    return psycopg.connect(**params, autocommit=True)


@skipUnless(connection.vendor == "postgresql", "PostgreSQL LISTEN/NOTIFY")
class LiveChangeNotificationTriggerTests(TransactionTestCase):
    def setUp(self):
        super().setUp()
        self.listener = open_listener()
        self.listener.execute("LISTEN releviz_events")
        self.organizer = create_member("live-triggers@example.com")
        self.event = self.make_event("LIVETRIG")
        self.drain()

    def tearDown(self):
        self.listener.close()
        super().tearDown()

    def make_event(self, code):
        return Event.objects.create(
            code=code,
            name=code,
            organizer=self.organizer,
            mode="inperson",
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            slot_minutes=30,
            meeting_duration_minutes=30,
            days=[1],
        )

    def make_participant(self, event, label):
        member = create_member(f"{label}@example.com")
        return Participant.objects.create(
            event=event,
            member=member,
            participant_name=label,
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
        )

    def payloads(self):
        """Every payload that arrives within a second, in delivery order."""

        return [notification.payload for notification in self.listener.notifies(timeout=1.0)]

    def drain(self):
        """Discard what the setup writes announced so a test sees only its own."""

        list(self.listener.notifies(timeout=0.2))

    def test_the_triggers_are_installed(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM pg_trigger WHERE tgname LIKE %s", ["releviz_notify_%"]
            )
            self.assertEqual(cursor.fetchone()[0], 27)

    def test_a_model_save_notifies_the_event_pk(self):
        self.make_participant(self.event, "saver")

        self.assertEqual(self.payloads(), [str(self.event.pk)])

    def test_a_queryset_update_notifies_each_touched_event_once(self):
        other = self.make_event("LIVEOTHER")
        people = [
            self.make_participant(self.event, "first"),
            self.make_participant(self.event, "second"),
            self.make_participant(other, "third"),
        ]
        self.drain()

        with transaction.atomic():
            Participant.objects.filter(pk__in=[person.pk for person in people]).update(hidden=True)

        self.assertEqual(sorted(self.payloads()), sorted([str(self.event.pk), str(other.pk)]))

    def test_a_bulk_update_notifies_the_event(self):
        people = [
            self.make_participant(self.event, "first"),
            self.make_participant(self.event, "second"),
        ]
        self.drain()
        for person in people:
            person.hidden = True

        Participant.objects.bulk_update(people, ["hidden"])

        self.assertEqual(self.payloads(), [str(self.event.pk)])

    def test_adding_a_group_membership_notifies_through_the_participant(self):
        participant = self.make_participant(self.event, "grouped")
        group = ParticipantGroup.objects.create(event=self.event, name="Judges")
        self.drain()

        participant.groups.add(group)

        self.assertEqual(self.payloads(), [str(self.event.pk)])

    def test_an_email_job_status_update_notifies_the_event(self):
        job = EmailDeliveryJob.objects.create(
            idempotency_key="live-trigger-job",
            message_type="invitation",
            recipient="invitee@example.com",
            subject="You are invited",
            body="Please respond.",
            message_id="<live-trigger-job@example.com>",
            event=self.event,
        )
        self.drain()

        EmailDeliveryJob.objects.filter(pk=job.pk).update(status=EmailDeliveryJob.Status.SENT)

        self.assertEqual(self.payloads(), [str(self.event.pk)])

    def test_publishing_a_result_snapshot_notifies_the_event(self):
        outcome = recompute_event_results(self.event.pk)

        self.assertTrue(outcome["published"])
        payloads = self.payloads()
        self.assertIn(str(self.event.pk), payloads)
        self.assertEqual(set(payloads), {str(self.event.pk)})

    def test_deleting_an_event_notifies_its_pk(self):
        self.make_participant(self.event, "leaver")
        self.drain()
        event_pk = self.event.pk

        self.event.delete()

        self.assertIn(str(event_pk), self.payloads())

    def test_a_rolled_back_transaction_is_silent(self):
        with self.assertRaises(RuntimeError), transaction.atomic():
            self.make_participant(self.event, "rolled-back")
            raise RuntimeError("roll the participant back")

        self.assertEqual(self.payloads(), [])
        self.assertFalse(Participant.objects.filter(participant_name="rolled-back").exists())
