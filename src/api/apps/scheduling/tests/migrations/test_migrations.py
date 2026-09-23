from importlib import import_module
from unittest.mock import patch

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TransactionTestCase
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


class ParticipantGroupMigrationTests(TransactionTestCase):
    """``Participant.group_name`` becomes rows in ``ParticipantGroup`` plus memberships."""

    migrate_from = ("scheduling", "0006_event_blocked_slots")
    migrate_to = ("scheduling", "0007_participantgroup_multi_membership")

    def _historical_apps(self, executor, target):
        # The scheduling graph only reaches authn's first migration through
        # the swappable dependency, so pin the authn leaf as well; otherwise
        # the historical Member would carry columns the database dropped.
        authn_leaf = next(node for node in executor.loader.graph.leaf_nodes() if node[0] == "authn")
        return executor.loader.project_state([target, authn_leaf]).apps

    def setUp(self):
        super().setUp()
        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_from])
        old_apps = self._historical_apps(self.executor, self.migrate_from)
        Member = old_apps.get_model("authn", "Member")
        Event = old_apps.get_model("scheduling", "Event")
        Participant = old_apps.get_model("scheduling", "Participant")
        self.assertIn("group_name", {field.name for field in Participant._meta.get_fields()})
        self.assertNotIn("all_groups", {field.name for field in Participant._meta.get_fields()})

        organizer = Member.objects.create(email="migration-organizer@example.com", password="!")
        event = Event.objects.create(
            code="MIGGROUP",
            name="Group migration",
            organizer=organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        self.event_id = event.pk
        # A second event with the same group name keeps its own row.
        other_event = Event.objects.create(
            code="MIGOTHER",
            name="Other event",
            organizer=organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        self.other_event_id = other_event.pk
        self.participant_ids = {}
        # The reserved token and the separator are legal in a legacy name;
        # "ALL" comes before "all" so its spelling names the shared row.
        for index, (label, group_name, target_event) in enumerate(
            [
                ("first", "Team 3", event),
                ("second", "team 3 ", event),
                ("blank", "", event),
                ("null", None, event),
                ("spaces", "   ", event),
                ("reserved", "ALL", event),
                ("reserved_lower", "all", event),
                ("separator", "Alpha;Beta", event),
                ("elsewhere", "TEAM 3", other_event),
            ]
        ):
            member = Member.objects.create(
                email=f"migration-{label}@example.com",
                password="!",
                first_name=label.title(),
            )
            participant = Participant.objects.create(
                event=target_event,
                member=member,
                participant_name=label.title(),
                availability_inperson=[0, 0],
                availability_virtual=[0, 0],
                group_name=group_name,
                sort_order=index,
            )
            self.participant_ids[label] = participant.pk

        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_to])

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_group_names_become_shared_group_rows_and_memberships(self):
        migrated_apps = self._historical_apps(self.executor, self.migrate_to)
        Participant = migrated_apps.get_model("scheduling", "Participant")
        ParticipantGroup = migrated_apps.get_model("scheduling", "ParticipantGroup")

        self.assertNotIn("group_name", {field.name for field in Participant._meta.get_fields()})
        self.assertFalse(Participant._meta.get_field("all_groups").default)

        # Case variants (and trailing whitespace) collapse into one row named
        # after the first spelling seen; other events get their own row. A
        # legacy "ALL" is renamed so it is not read as the reserved token, and
        # a legacy ";" becomes "," so the name is still one token.
        groups = {
            group.name: group for group in ParticipantGroup.objects.filter(event_id=self.event_id)
        }
        self.assertEqual(sorted(groups), ["ALL (group)", "Alpha,Beta", "Team 3"])
        group = groups["Team 3"]
        everyone = groups["ALL (group)"]
        pair = groups["Alpha,Beta"]
        other_group = ParticipantGroup.objects.get(event_id=self.other_event_id)
        self.assertEqual(other_group.name, "TEAM 3")
        self.assertEqual(ParticipantGroup.objects.count(), 4)

        memberships = {
            label: sorted(
                Participant.objects.get(pk=participant_id).groups.values_list("pk", flat=True)
            )
            for label, participant_id in self.participant_ids.items()
        }
        self.assertEqual(
            memberships,
            {
                "first": [group.pk],
                "second": [group.pk],
                "blank": [],
                "null": [],
                "spaces": [],
                "reserved": [everyone.pk],
                "reserved_lower": [everyone.pk],
                "separator": [pair.pk],
                "elsewhere": [other_group.pk],
            },
        )
        self.assertEqual(
            sorted(group.participants.values_list("participant_name", flat=True)),
            ["First", "Second"],
        )
        self.assertEqual(
            sorted(everyone.participants.values_list("participant_name", flat=True)),
            ["Reserved", "Reserved_Lower"],
        )
        self.assertEqual(
            list(pair.participants.values_list("participant_name", flat=True)), ["Separator"]
        )
        # A legacy "ALL" was a plain name, never membership of every group.
        self.assertFalse(Participant.objects.filter(all_groups=True).exists())
        self.assertEqual(Participant.objects.count(), 9)

    def test_reversing_restores_the_group_name_column_without_memberships(self):
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        old_apps = self._historical_apps(executor, self.migrate_from)
        Participant = old_apps.get_model("scheduling", "Participant")

        # The data step is a no-op backwards, so the restored column is empty
        # while every participant row survives.
        self.assertIn("group_name", {field.name for field in Participant._meta.get_fields()})
        self.assertEqual(Participant.objects.count(), 9)
        self.assertEqual(
            set(Participant.objects.values_list("group_name", flat=True)),
            {None},
        )
        self.assertNotIn(
            "scheduling_participantgroup",
            connection.introspection.table_names(),
        )


class LegacyGroupNameTests(SimpleTestCase):
    """The pure rewrite the data migration applies to each legacy ``group_name``."""

    def test_legacy_names_are_rewritten_into_the_cell_grammar(self):
        migration = import_module(
            "apps.scheduling.migrations.0007_participantgroup_multi_membership"
        )
        legacy_group_name = migration.legacy_group_name

        self.assertEqual(legacy_group_name(""), "")
        self.assertEqual(legacy_group_name(None), "")
        self.assertEqual(legacy_group_name("   "), "")
        self.assertEqual(legacy_group_name(" Team 3 "), "Team 3")
        # The separator is replaced before stripping, so the name stays one token.
        self.assertEqual(legacy_group_name("  x ; y "), "x , y")
        # Any spelling of the reserved token keeps its case but gains a suffix.
        self.assertEqual(legacy_group_name("aLL"), "aLL (group)")
        self.assertEqual(legacy_group_name(" all "), "all (group)")
        self.assertEqual(legacy_group_name("Allies"), "Allies")
