from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


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


class ParticipantGroupMigrationTests(TransactionTestCase):
    """``Participant.group_name`` becomes rows in ``ParticipantGroup`` plus memberships."""

    migrate_from = ("scheduling", "0003_alter_rosterimportreceipt_batch")
    migrate_to = ("scheduling", "0004_participantgroup_multi_membership")

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
        for index, (label, group_name, target_event) in enumerate(
            [
                ("first", "Team 3", event),
                ("second", "team 3 ", event),
                ("blank", "", event),
                ("null", None, event),
                ("spaces", "   ", event),
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
        # after the first spelling seen; other events get their own row.
        group = ParticipantGroup.objects.get(event_id=self.event_id)
        self.assertEqual(group.name, "Team 3")
        other_group = ParticipantGroup.objects.get(event_id=self.other_event_id)
        self.assertEqual(other_group.name, "TEAM 3")
        self.assertEqual(ParticipantGroup.objects.count(), 2)

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
                "elsewhere": [other_group.pk],
            },
        )
        self.assertEqual(
            sorted(group.participants.values_list("participant_name", flat=True)),
            ["First", "Second"],
        )
        self.assertFalse(Participant.objects.filter(all_groups=True).exists())
        self.assertEqual(Participant.objects.count(), 6)

    def test_reversing_restores_the_group_name_column_without_memberships(self):
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        old_apps = self._historical_apps(executor, self.migrate_from)
        Participant = old_apps.get_model("scheduling", "Participant")

        # The data step is a no-op backwards, so the restored column is empty
        # while every participant row survives.
        self.assertIn("group_name", {field.name for field in Participant._meta.get_fields()})
        self.assertEqual(Participant.objects.count(), 6)
        self.assertEqual(
            set(Participant.objects.values_list("group_name", flat=True)),
            {None},
        )
        self.assertNotIn(
            "scheduling_participantgroup",
            connection.introspection.table_names(),
        )
