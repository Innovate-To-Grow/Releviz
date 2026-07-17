import json

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

from apps.authn.tests.helpers import create_member


class MinuteSlotMigrationTests(TransactionTestCase):
    migrate_from = ("scheduling", "0005_event_timezone_finalmeeting_finalizationrequest")
    migrate_to = ("scheduling", "0006_minute_slots_and_native_availability")

    def setUp(self):
        super().setUp()
        self.organizer = create_member("slot-migration@example.com")
        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_from])
        old_apps = self.executor.loader.project_state([self.migrate_from]).apps
        Event = old_apps.get_model("scheduling", "Event")
        Participant = old_apps.get_model("scheduling", "Participant")

        event = Event.objects.create(
            code="FULLDAY",
            name="Legacy full day",
            organizer_id=self.organizer.pk,
            start_hour=0,
            end_hour=24,
            days=[1, 3],
            timezone="UTC",
        )
        old_values = [0] * (24 * 7)
        for hour in range(24):
            old_values[hour * 7 + 1] = 1
            old_values[hour * 7 + 3] = 0.5
        Participant.objects.create(
            event_id=event.pk,
            member_id=self.organizer.pk,
            participant_name="Legacy Organizer",
            schedule_inperson=json.dumps(old_values),
            schedule_virtual=json.dumps(old_values),
        )

        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_to])

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_full_day_hourly_data_migrates_to_native_half_hour_arrays(self):
        from apps.scheduling.utils import expected_availability_length

        migrated_apps = self.executor.loader.project_state([self.migrate_to]).apps
        Event = migrated_apps.get_model("scheduling", "Event")
        Participant = migrated_apps.get_model("scheduling", "Participant")
        event = Event.objects.get(code="FULLDAY")
        participant = Participant.objects.get(event=event)
        self.assertEqual(event.start_minutes, 0)
        self.assertEqual(event.end_minutes, 0)
        self.assertTrue(event.spans_next_day)
        self.assertEqual(event.slot_minutes, 30)
        self.assertEqual(expected_availability_length(event), 96)
        self.assertIsInstance(participant.availability_inperson, list)
        self.assertEqual(participant.availability_inperson[:48], [1] * 48)
        self.assertEqual(participant.availability_inperson[48:], [0.5] * 48)
