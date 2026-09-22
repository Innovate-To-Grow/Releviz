from importlib import import_module
from unittest.mock import patch

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone

starting_availability_migration = import_module(
    "apps.scheduling.migrations.0004_event_starting_availability"
)


class ActiveStatusMigrationTests(TransactionTestCase):
    migrate_from = ("scheduling", "0001_initial")
    migrate_to = ("scheduling", "0002_event_status_active")

    def setUp(self):
        super().setUp()
        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_from])
        old_apps = self.executor.loader.project_state([self.migrate_from]).apps
        self.assertFalse(old_apps.get_model("scheduling", "Event").objects.exists())

        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_to])

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_empty_database_migrates_to_active_status_contract(self):
        migrated_apps = self.executor.loader.project_state([self.migrate_to]).apps
        Event = migrated_apps.get_model("scheduling", "Event")
        status_field = Event._meta.get_field("status")
        self.assertEqual(status_field.default, "active")
        self.assertEqual(
            {value for value, _label in status_field.choices},
            {"active", "closed", "finalized", "archived"},
        )


class StartingAvailabilityMigrationTests(TransactionTestCase):
    migrate_from = ("scheduling", "0003_alter_rosterimportreceipt_batch")
    migrate_to = ("scheduling", "0004_event_starting_availability")

    @staticmethod
    def targets(executor, scheduling_node):
        """Pin every other app at its leaf so historical models match the real tables."""
        return [node for node in executor.loader.graph.leaf_nodes() if node[0] != "scheduling"] + [
            scheduling_node
        ]

    def setUp(self):
        super().setUp()
        self.executor = MigrationExecutor(connection)
        from_targets = self.targets(self.executor, self.migrate_from)
        self.executor.migrate(from_targets)
        old_apps = self.executor.loader.project_state(from_targets).apps
        Member = old_apps.get_model("authn", "Member")
        Event = old_apps.get_model("scheduling", "Event")
        Participant = old_apps.get_model("scheduling", "Participant")
        self.assertFalse(hasattr(Event, "starting_availability"))

        organizer = Member.objects.create(password="!", first_name="Org", last_name="Owner")
        self.event = Event.objects.create(
            code="MIGRATE4",
            name="Legacy busy-start event",
            organizer=organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )

        def person(label, *, inperson, virtual, submitted, **timestamps):
            member = Member.objects.create(password="!", first_name=label, last_name="Person")
            return Participant.objects.create(
                event=self.event,
                member=member,
                participant_name=label,
                availability_inperson=inperson,
                availability_virtual=virtual,
                submitted=submitted,
                **timestamps,
            )

        self.untouched = person("Untouched", inperson=[0, 0], virtual=[0, 0], submitted=False)
        self.submitted = person("Submitted", inperson=[0, 0], virtual=[0, 0], submitted=True)
        self.painted = person("Painted", inperson=[0, 1], virtual=[0, 0], submitted=False)
        self.virtual_painted = person(
            "Virtual painted", inperson=[0, 0], virtual=[1, 0], submitted=False
        )
        self.empty = person("Empty", inperson=[], virtual=[], submitted=False)
        # Under the old rules an all-busy saved draft was a deliberate "nothing works".
        self.drafted_busy = person(
            "Drafted busy",
            inperson=[0, 0],
            virtual=[0, 0],
            submitted=False,
            first_draft_saved_at=timezone.now(),
        )
        self.withdrawn = person(
            "Withdrawn",
            inperson=[0, 0],
            virtual=[0, 0],
            submitted=False,
            first_submitted_at=timezone.now(),
            last_submitted_at=timezone.now(),
        )
        self.more_untouched = [
            person(f"Untouched {index}", inperson=[0, 0], virtual=[0, 0], submitted=False)
            for index in range(3)
        ]
        self.untouched_updated_at = self.untouched.updated_at

        self.executor = MigrationExecutor(connection)
        self.to_targets = self.targets(self.executor, self.migrate_to)
        # A tiny chunk size forces the data step through its mid-loop flush as well.
        with patch.object(starting_availability_migration, "RESEED_CHUNK_SIZE", 2):
            self.executor.migrate(self.to_targets)

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_untouched_busy_schedules_become_available_and_everyone_else_is_kept(self):
        migrated_apps = self.executor.loader.project_state(self.to_targets).apps
        Event = migrated_apps.get_model("scheduling", "Event")
        Participant = migrated_apps.get_model("scheduling", "Participant")

        event = Event.objects.get(pk=self.event.pk)
        self.assertEqual(event.starting_availability, "available")
        self.assertEqual(
            {value for value, _label in Event._meta.get_field("starting_availability").choices},
            {"available", "busy"},
        )

        untouched = Participant.objects.get(pk=self.untouched.pk)
        self.assertEqual(untouched.availability_inperson, [1, 1])
        self.assertEqual(untouched.availability_virtual, [1, 1])
        self.assertEqual(untouched.version, 2)
        self.assertFalse(untouched.submitted)
        self.assertGreater(untouched.updated_at, self.untouched_updated_at)

        submitted = Participant.objects.get(pk=self.submitted.pk)
        self.assertEqual(submitted.availability_inperson, [0, 0])
        self.assertEqual(submitted.availability_virtual, [0, 0])
        self.assertEqual(submitted.version, 1)
        self.assertTrue(submitted.submitted)

        painted = Participant.objects.get(pk=self.painted.pk)
        self.assertEqual(painted.availability_inperson, [0, 1])
        self.assertEqual(painted.availability_virtual, [0, 0])
        self.assertEqual(painted.version, 1)

        virtual_painted = Participant.objects.get(pk=self.virtual_painted.pk)
        self.assertEqual(virtual_painted.availability_inperson, [0, 0])
        self.assertEqual(virtual_painted.availability_virtual, [1, 0])
        self.assertEqual(virtual_painted.version, 1)

        empty = Participant.objects.get(pk=self.empty.pk)
        self.assertEqual(empty.availability_inperson, [])
        self.assertEqual(empty.availability_virtual, [])
        self.assertEqual(empty.version, 1)

        for original in (self.drafted_busy, self.withdrawn):
            participant = Participant.objects.get(pk=original.pk)
            self.assertEqual(participant.availability_inperson, [0, 0])
            self.assertEqual(participant.availability_virtual, [0, 0])
            self.assertEqual(participant.version, 1)

        for original in self.more_untouched:
            participant = Participant.objects.get(pk=original.pk)
            self.assertEqual(participant.availability_inperson, [1, 1])
            self.assertEqual(participant.availability_virtual, [1, 1])
            self.assertEqual(participant.version, 2)

    def test_migration_reverses_the_untouched_schedules_back_to_busy(self):
        reversed_executor = MigrationExecutor(connection)
        from_targets = self.targets(reversed_executor, self.migrate_from)
        with patch.object(starting_availability_migration, "RESEED_CHUNK_SIZE", 2):
            reversed_executor.migrate(from_targets)
        old_apps = reversed_executor.loader.project_state(from_targets).apps
        Participant = old_apps.get_model("scheduling", "Participant")
        self.assertFalse(
            hasattr(old_apps.get_model("scheduling", "Event"), "starting_availability")
        )
        for original in (self.untouched, *self.more_untouched):
            participant = Participant.objects.get(pk=original.pk)
            self.assertEqual(participant.availability_inperson, [0, 0])
            self.assertEqual(participant.availability_virtual, [0, 0])
            self.assertEqual(participant.version, 3)
        # Everyone the forward step left alone is left alone on the way back too.
        for original, inperson, virtual in (
            (self.submitted, [0, 0], [0, 0]),
            (self.painted, [0, 1], [0, 0]),
            (self.virtual_painted, [0, 0], [1, 0]),
            (self.empty, [], []),
            (self.drafted_busy, [0, 0], [0, 0]),
            (self.withdrawn, [0, 0], [0, 0]),
        ):
            participant = Participant.objects.get(pk=original.pk)
            self.assertEqual(participant.availability_inperson, inperson)
            self.assertEqual(participant.availability_virtual, virtual)
            self.assertEqual(participant.version, 1)
