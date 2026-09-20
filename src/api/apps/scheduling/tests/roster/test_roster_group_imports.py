"""Group cells through the roster import and the participant update endpoint."""

import uuid

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.models import (
    Event,
    Participant,
    ParticipantGroup,
    RosterImportRow,
    UserEvent,
)

GROUP_TOO_LONG = "group is too long (max 100)."
TOO_MANY_GROUPS = "group may list at most 100 names."
LONG_TOKEN = "x" * 101
# Thirty short names whose joined cell is far longer than one name may be.
MANY_NAMES = "; ".join(f"g{index:03d}" for index in range(1, 31))
HUNDRED_NAMES = [f"n{index:03d}" for index in range(1, 101)]


def group_names(participant) -> list[str]:
    return list(participant.groups.values_list("name", flat=True))


def event_group_names(event) -> list[str]:
    return list(event.participant_groups.values_list("name", flat=True))


class RosterGroupImportTestCase(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("owner@example.com", "Event", "Owner")
        self.event = Event.objects.create(
            code="GROUPS01",
            name="Grouped event",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        UserEvent.objects.create(member=self.organizer, event=self.event, role="organizer")
        self.authenticate(self.organizer)

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def paste(self, content):
        response = self.client.post(
            f"/events/roster-imports?code={self.event.code}",
            {"sourceType": "paste", "pastedText": content},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        return response

    def rows(self, import_id):
        response = self.client.get(
            f"/events/roster-imports/{import_id}/rows?code={self.event.code}"
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response.data["rows"]

    def update(self, import_id, payload):
        return self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            payload,
            format="json",
        )

    def commit(self, import_id, *, mode="merge", confirmation=None):
        payload = {"mode": mode, "idempotencyKey": str(uuid.uuid4())}
        if confirmation is not None:
            payload["confirmationCode"] = confirmation
        return self.client.post(
            f"/events/roster-imports/{import_id}/commit?code={self.event.code}",
            payload,
            format="json",
        )

    def import_rows(self, content, *, mode="merge", confirmation=None):
        """Paste, commit, and return the commit response."""

        preview = self.paste(content)
        committed = self.commit(preview.data["import"]["id"], mode=mode, confirmation=confirmation)
        self.assertEqual(committed.status_code, 201, committed.data)
        return committed

    def participant(self, email) -> Participant:
        return Participant.objects.get(event=self.event, member__email=email)


class RosterImportGroupPreviewTests(RosterGroupImportTestCase):
    def test_mapped_group_cells_are_stored_in_canonical_form(self):
        preview = self.paste(
            "name\temail\tgroup\n"
            "Alice\talice@example.com\tall; a ; B; a\n"
            "Bob\tbob@example.com\tALL\n"
            "Cara\tcara@example.com\t\n"
            f"Dan\tdan@example.com\t{MANY_NAMES}\n"
            f"Eve\teve@example.com\t{LONG_TOKEN}\n"
        )
        self.assertEqual(
            preview.data["import"]["columnMapping"], {"name": 0, "email": 1, "group": 2}
        )
        self.assertEqual(
            preview.data["import"]["summary"],
            {"total": 5, "selected": 5, "valid": 4, "invalid": 1, "conflicts": 0},
        )

        rows = self.rows(preview.data["import"]["id"])
        by_email = {row["email"]: row for row in rows}
        self.assertEqual(by_email["alice@example.com"]["group"], "ALL; a; B")
        self.assertEqual(by_email["alice@example.com"]["errors"], [])
        self.assertEqual(by_email["bob@example.com"]["group"], "ALL")
        self.assertEqual(by_email["cara@example.com"]["group"], "")
        self.assertTrue(by_email["cara@example.com"]["valid"])
        # A long cell made of short names is fine: the limit is per name.
        self.assertGreater(len(MANY_NAMES), 100)
        self.assertEqual(by_email["dan@example.com"]["group"], MANY_NAMES)
        self.assertEqual(by_email["dan@example.com"]["errors"], [])
        self.assertTrue(by_email["dan@example.com"]["valid"])
        # A single name over the limit keeps the typed cell next to its error.
        self.assertEqual(by_email["eve@example.com"]["group"], LONG_TOKEN)
        self.assertEqual(by_email["eve@example.com"]["errors"], [GROUP_TOO_LONG])
        self.assertFalse(by_email["eve@example.com"]["valid"])
        stored = RosterImportRow.objects.get(email="dan@example.com")
        self.assertEqual(stored.group_name, MANY_NAMES)

    def test_default_group_is_normalized_and_applied_to_unmapped_rows(self):
        preview = self.paste("name,email\nAlice,alice@example.com\nBob,bob@example.com\n")
        import_id = preview.data["import"]["id"]
        self.assertEqual(preview.data["import"]["defaults"]["group"], "")
        self.assertEqual(self.rows(import_id)[0]["group"], "")

        updated = self.update(import_id, {"defaults": {"group": " Faculty ; all "}})
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(
            updated.data["import"]["defaults"],
            {"group": "ALL; Faculty", "weight": 1.0, "included": True},
        )
        self.assertEqual(updated.data["import"]["summary"]["valid"], 2)
        self.assertEqual([row["group"] for row in self.rows(import_id)], ["ALL; Faculty"] * 2)

        # ``groupName`` is accepted as an alias for the default group.
        aliased = self.update(import_id, {"defaults": {"groupName": "Guests"}})
        self.assertEqual(aliased.status_code, 200, aliased.data)
        self.assertEqual(aliased.data["import"]["defaults"]["group"], "Guests")
        self.assertEqual([row["group"] for row in self.rows(import_id)], ["Guests"] * 2)

        too_long = self.update(import_id, {"defaults": {"group": LONG_TOKEN}})
        self.assertEqual(too_long.status_code, 400)
        self.assertEqual(too_long.data, {"error": f"defaults.{GROUP_TOO_LONG}"})
        # The rejected default left the preview as it was.
        self.assertEqual([row["group"] for row in self.rows(import_id)], ["Guests"] * 2)

    def test_row_updates_normalize_group_cells_and_report_long_names(self):
        preview = self.paste("name,email\nAlice,alice@example.com\nBob,bob@example.com\n")
        import_id = preview.data["import"]["id"]
        alice, bob = self.rows(import_id)

        normalized = self.update(
            import_id,
            {
                "rowUpdates": [
                    {"id": alice["id"], "group": "b; a"},
                    {"id": bob["id"], "groupName": LONG_TOKEN},
                ]
            },
        )
        self.assertEqual(normalized.status_code, 200, normalized.data)
        self.assertEqual(
            normalized.data["import"]["summary"],
            {"total": 2, "selected": 2, "valid": 1, "invalid": 1, "conflicts": 0},
        )
        alice, bob = self.rows(import_id)
        self.assertEqual(alice["group"], "b; a")
        self.assertTrue(alice["valid"])
        self.assertEqual(bob["group"], LONG_TOKEN)
        self.assertFalse(bob["valid"])
        self.assertEqual(bob["errors"], [GROUP_TOO_LONG])

        # A null cell clears the group and the error along with it; a row
        # update that does not mention the group leaves it alone.
        cleared = self.update(
            import_id,
            {
                "rowUpdates": [
                    {"id": bob["id"], "group": None},
                    {"id": alice["id"], "name": "Alice Renamed"},
                ]
            },
        )
        self.assertEqual(cleared.status_code, 200, cleared.data)
        self.assertEqual(cleared.data["import"]["summary"]["valid"], 2)
        alice, bob = self.rows(import_id)
        self.assertEqual(bob["group"], "")
        self.assertEqual(bob["errors"], [])
        self.assertEqual(alice["name"], "Alice Renamed")
        self.assertEqual(alice["group"], "b; a")

    def test_mapped_group_formula_cell_is_reported(self):
        preview = self.paste("name,email,group\nFormula,formula@example.com,=SUM(A1)\n")
        self.assertEqual(preview.data["import"]["summary"]["invalid"], 1)
        row = self.rows(preview.data["import"]["id"])[0]
        self.assertEqual(row["errors"], ["group cannot contain a formula."])
        self.assertFalse(row["valid"])


class RosterImportGroupDuplicateTests(RosterGroupImportTestCase):
    def test_duplicate_rows_are_identical_only_when_the_normalized_cell_matches(self):
        preview = self.paste(
            "name\temail\tgroup\n"
            "Dup\tdup@example.com\tA; B\n"
            "Dup\tdup@example.com\tB; A\n"
            "Same\tsame@example.com\ta; b\n"
            "Same\tsame@example.com\tA; B\n"
            "Twin\ttwin@example.com\tA; B\n"
            "Twin\ttwin@example.com\tA; B\n"
        )
        self.assertEqual(
            preview.data["import"]["summary"],
            {"total": 6, "selected": 5, "valid": 1, "invalid": 4, "conflicts": 4},
        )
        rows = self.rows(preview.data["import"]["id"])
        # Order matters in the signature: "A; B" and "B; A" conflict.
        self.assertEqual([row["duplicate"] for row in rows[:2]], ["conflict", "conflict"])
        self.assertEqual([row["group"] for row in rows[:2]], ["A; B", "B; A"])
        # So does case: "a; b" and "A; B" are different normalized cells.
        self.assertEqual([row["duplicate"] for row in rows[2:4]], ["conflict", "conflict"])
        self.assertEqual([row["group"] for row in rows[2:4]], ["a; b", "A; B"])
        for row in rows[:4]:
            self.assertTrue(row["selected"])
            self.assertEqual(row["errors"], ["Conflicting duplicate email."])
        # Only a byte-identical normalized cell makes the second row identical.
        self.assertEqual([row["duplicate"] for row in rows[4:]], ["unique", "identical"])
        self.assertTrue(rows[4]["selected"])
        self.assertFalse(rows[5]["selected"])
        self.assertEqual(rows[5]["errors"], [])


class RosterImportGroupCommitTests(RosterGroupImportTestCase):
    def test_merge_into_an_empty_roster_creates_groups_once_and_counts_all_members(self):
        committed = self.import_rows(
            "name\temail\tgroup\n"
            "Fay\tfay@example.com\tFaculty\n"
            "Gil\tgil@example.com\tfaculty; Team 3\n"
            "Hal\thal@example.com\tALL\n"
            "Ivy\tivy@example.com\tALL; Faculty\n"
            "Jon\tjon@example.com\t\n"
        )
        self.assertEqual(committed.data["receipt"]["createdCount"], 5)
        self.assertEqual(committed.data["receipt"]["updatedCount"], 0)

        # "faculty" reused "Faculty" instead of creating a case variant.
        self.assertEqual(event_group_names(self.event), ["Faculty", "Team 3"])
        faculty = ParticipantGroup.objects.get(event=self.event, name="Faculty")
        team = ParticipantGroup.objects.get(event=self.event, name="Team 3")

        fay = self.participant("fay@example.com")
        gil = self.participant("gil@example.com")
        hal = self.participant("hal@example.com")
        ivy = self.participant("ivy@example.com")
        jon = self.participant("jon@example.com")
        self.assertEqual(group_names(fay), ["Faculty"])
        self.assertEqual(group_names(gil), ["Faculty", "Team 3"])
        self.assertEqual(group_names(hal), [])
        self.assertEqual(group_names(ivy), ["Faculty"])
        self.assertEqual(group_names(jon), [])
        self.assertEqual(
            [person.all_groups for person in (fay, gil, hal, ivy, jon)],
            [False, False, True, True, False],
        )
        self.assertEqual(
            list(Participant.objects.filter(event=self.event).values_list("version", flat=True)),
            [1] * 5,
        )

        roster = self.client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(roster.status_code, 200, roster.data)
        self.assertEqual(roster.data["stats"]["total"], 5)
        self.assertEqual(
            roster.data["stats"]["groups"],
            [
                {"id": faculty.pk, "name": "Faculty", "count": 4, "weight": 1.0},
                {"id": team.pk, "name": "Team 3", "count": 3, "weight": 1.0},
                {"id": None, "name": "", "count": 1, "weight": 1.0},
            ],
        )
        memberships = {
            row["name"]: (row["group"], row["groups"], row["allGroups"])
            for row in roster.data["participants"]
        }
        faculty_entry = {"id": faculty.pk, "name": "Faculty"}
        team_entry = {"id": team.pk, "name": "Team 3"}
        self.assertEqual(
            memberships,
            {
                "Fay": ("Faculty", [faculty_entry], False),
                "Gil": ("Faculty; Team 3", [faculty_entry, team_entry], False),
                "Hal": ("ALL", [], True),
                "Ivy": ("ALL; Faculty", [faculty_entry], True),
                "Jon": ("", [], False),
            },
        )

    def test_merge_onto_an_existing_person_replaces_only_when_the_cell_is_set(self):
        first = self.import_rows("name\temail\tgroup\nX\tx@example.com\tA\n")
        self.assertEqual(first.data["receipt"]["createdCount"], 1)
        self.assertEqual(first.data["receipt"]["updatedCount"], 0)
        person = self.participant("x@example.com")
        self.assertEqual(person.version, 1)
        self.assertEqual(group_names(person), ["A"])
        self.assertFalse(person.all_groups)

        # A blank cell leaves the memberships, the flag, and the version alone.
        blank = self.import_rows("name\temail\tgroup\nX\tx@example.com\t\n")
        self.assertEqual(blank.data["receipt"]["createdCount"], 0)
        self.assertEqual(blank.data["receipt"]["updatedCount"], 1)
        person.refresh_from_db()
        self.assertEqual(person.version, 1)
        self.assertEqual(group_names(person), ["A"])
        self.assertFalse(person.all_groups)

        # A new cell replaces the memberships; the old group row survives.
        replaced = self.import_rows("name\temail\tgroup\nX\tx@example.com\tB\n")
        self.assertEqual(replaced.data["receipt"]["updatedCount"], 1)
        person.refresh_from_db()
        self.assertEqual(person.version, 2)
        self.assertEqual(person.participant_name, "X")
        self.assertEqual(group_names(person), ["B"])
        self.assertEqual(event_group_names(self.event), ["A", "B"])

        # A rename plus a membership change bumps the version exactly once.
        everywhere = self.import_rows("name\temail\tgroup\nX Renamed\tx@example.com\tALL\n")
        self.assertEqual(everywhere.data["receipt"]["updatedCount"], 1)
        person.refresh_from_db()
        self.assertEqual(person.version, 3)
        self.assertEqual(person.participant_name, "X Renamed")
        self.assertTrue(person.all_groups)
        self.assertEqual(group_names(person), [])
        self.assertEqual(
            Participant.groups.through.objects.filter(participant_id=person.pk).count(), 0
        )

        # The identical cell again counts as an update but changes nothing.
        again = self.import_rows("name\temail\tgroup\nX Renamed\tx@example.com\tALL\n")
        self.assertEqual(again.data["receipt"]["createdCount"], 0)
        self.assertEqual(again.data["receipt"]["updatedCount"], 1)
        person.refresh_from_db()
        self.assertEqual(person.version, 3)
        self.assertTrue(person.all_groups)
        self.assertEqual(group_names(person), [])
        self.assertEqual(event_group_names(self.event), ["A", "B"])
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 1)

    def test_rebuild_drops_every_group_and_rebuilds_memberships_from_the_rows(self):
        self.import_rows("name\temail\tgroup\nP1\tp1@example.com\tA; B\nP2\tp2@example.com\tC\n")
        self.assertEqual(event_group_names(self.event), ["A", "B", "C"])
        old_participant_ids = list(
            Participant.objects.filter(event=self.event).values_list("pk", flat=True)
        )
        old_group_ids = list(self.event.participant_groups.values_list("pk", flat=True))
        through = Participant.groups.through
        self.assertEqual(through.objects.filter(participant_id__in=old_participant_ids).count(), 3)

        rebuilt = self.import_rows(
            "name\temail\tgroup\nP2\tp2@example.com\tD\nP3\tp3@example.com\tALL\n",
            mode="rebuild",
            confirmation=self.event.code,
        )
        self.assertEqual(rebuilt.data["receipt"]["mode"], "rebuild")
        self.assertEqual(rebuilt.data["receipt"]["createdCount"], 2)
        self.assertEqual(rebuilt.data["receipt"]["updatedCount"], 0)

        self.assertEqual(event_group_names(self.event), ["D"])
        self.assertFalse(ParticipantGroup.objects.filter(pk__in=old_group_ids).exists())
        self.assertFalse(Participant.objects.filter(pk__in=old_participant_ids).exists())
        self.assertEqual(through.objects.filter(participant_id__in=old_participant_ids).count(), 0)
        self.assertEqual(through.objects.filter(participantgroup_id__in=old_group_ids).count(), 0)
        self.assertEqual(
            sorted(
                Participant.objects.filter(event=self.event).values_list(
                    "participant_name", flat=True
                )
            ),
            ["P2", "P3"],
        )
        second = self.participant("p2@example.com")
        third = self.participant("p3@example.com")
        self.assertEqual(group_names(second), ["D"])
        self.assertFalse(second.all_groups)
        self.assertEqual(group_names(third), [])
        self.assertTrue(third.all_groups)
        self.assertEqual(through.objects.filter(participantgroup__event=self.event).count(), 1)

        group = ParticipantGroup.objects.get(event=self.event)
        roster = self.client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(roster.status_code, 200, roster.data)
        self.assertEqual(
            roster.data["stats"]["groups"],
            [{"id": group.pk, "name": "D", "count": 2, "weight": 1.0}],
        )


class ParticipantUpdateGroupTests(RosterGroupImportTestCase):
    def setUp(self):
        super().setUp()
        self.import_rows("name\temail\nTemp\ttemp@example.com\n")
        self.event.refresh_from_db()
        self.temporary = self.participant("temp@example.com")
        self.assertEqual(self.temporary.member.access_level, "temporary")
        self.assertEqual(self.temporary.version, 1)
        self.initial_revision = self.event.results_revision

    def put(self, payload, *, participant=None):
        participant = participant or self.temporary
        return self.client.put(
            f"/events/participants/update?code={self.event.code}"
            f"&participantId={participant.member_id}",
            payload,
            format="json",
        )

    def assert_results_revision_unchanged(self):
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, self.initial_revision)

    def test_group_cell_creates_groups_and_bumps_the_version_once_per_change(self):
        updated = self.put({"groupName": " ALL; A ; b "})
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertIn("no-store", updated["Cache-Control"])
        self.assertEqual(event_group_names(self.event), ["A", "b"])
        group_a = ParticipantGroup.objects.get(event=self.event, name="A")
        group_b = ParticipantGroup.objects.get(event=self.event, name="b")
        payload = updated.data["participant"]
        self.assertEqual(payload["group_name"], "ALL; A; b")
        self.assertEqual(
            payload["groups"],
            [{"id": group_a.pk, "name": "A"}, {"id": group_b.pk, "name": "b"}],
        )
        self.assertTrue(payload["allGroups"])
        self.assertEqual(payload["version"], 2)
        self.assertEqual(payload["accountAccess"], "temporary")
        self.assertEqual(payload["email"], "temp@example.com")
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.version, 2)
        self.assertTrue(self.temporary.all_groups)
        self.assertEqual(group_names(self.temporary), ["A", "b"])
        self.assert_results_revision_unchanged()

        # The same cell again is a no-op: no version bump, same payload.
        repeated = self.put({"groupName": "ALL; A; b"})
        self.assertEqual(repeated.status_code, 200, repeated.data)
        self.assertEqual(repeated.data["participant"]["version"], 2)
        self.assertEqual(repeated.data["participant"]["group_name"], "ALL; A; b")
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.version, 2)
        self.assertEqual(event_group_names(self.event), ["A", "b"])

        # A blank cell clears the memberships and the flag; the groups stay.
        cleared = self.put({"groupName": ""})
        self.assertEqual(cleared.status_code, 200, cleared.data)
        self.assertIsNone(cleared.data["participant"]["group_name"])
        self.assertEqual(cleared.data["participant"]["groups"], [])
        self.assertFalse(cleared.data["participant"]["allGroups"])
        self.assertEqual(cleared.data["participant"]["version"], 3)
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.version, 3)
        self.assertFalse(self.temporary.all_groups)
        self.assertEqual(group_names(self.temporary), [])
        self.assertEqual(event_group_names(self.event), ["A", "b"])
        self.assert_results_revision_unchanged()

    def test_invalid_group_cell_is_rejected_before_anything_changes(self):
        rejected = self.put({"groupName": LONG_TOKEN})
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(rejected.data, {"error": GROUP_TOO_LONG})
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.version, 1)
        self.assertEqual(event_group_names(self.event), [])
        self.assert_results_revision_unchanged()

    def test_only_the_organizer_can_set_groups(self):
        member = create_member("self@example.com", "Self", "Person")
        self.import_rows("name\temail\nSelf Person\tself@example.com\n")
        self.event.refresh_from_db()
        self.initial_revision = self.event.results_revision
        full = self.participant("self@example.com")
        self.assertEqual(full.member_id, member.pk)

        # The organizer may group a full account: membership is roster
        # metadata, not a response edit.
        grouped = self.put({"groupName": "A"}, participant=full)
        self.assertEqual(grouped.status_code, 200, grouped.data)
        self.assertEqual(grouped.data["participant"]["group_name"], "A")
        self.assertEqual(grouped.data["participant"]["version"], 2)

        self.authenticate(member)
        forbidden = self.put({"groupName": "B"}, participant=full)
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(
            forbidden.data,
            {
                "error": "Only the organizer can update participant groups",
                "errorCode": "participant_update_forbidden",
            },
        )
        full.refresh_from_db()
        self.assertEqual(full.version, 2)
        self.assertEqual(group_names(full), ["A"])
        self.assertEqual(event_group_names(self.event), ["A"])
        self.assert_results_revision_unchanged()

    def test_group_and_sort_order_together_bump_the_version_once(self):
        updated = self.put({"groupName": "A", "sortOrder": 2})
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(updated.data["participant"]["group_name"], "A")
        self.assertEqual(updated.data["participant"]["sort_order"], 2)
        self.assertEqual(updated.data["participant"]["version"], 2)
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.version, 2)
        self.assertEqual(self.temporary.sort_order, 2)
        self.assertEqual(group_names(self.temporary), ["A"])
        self.assert_results_revision_unchanged()

    def test_group_and_name_together_bump_the_version_once(self):
        updated = self.put({"name": "New", "groupName": "Z", "expectedVersion": 1})
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(updated.data["participant"]["name"], "New")
        self.assertEqual(updated.data["participant"]["group_name"], "Z")
        self.assertEqual(updated.data["participant"]["version"], 2)
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.participant_name, "New")
        self.assertEqual(self.temporary.version, 2)
        self.assertEqual(group_names(self.temporary), ["Z"])
        self.assertEqual(event_group_names(self.event), ["Z"])
        self.assert_results_revision_unchanged()

    def assert_membership_untouched(self):
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.version, 1)
        self.assertEqual(self.temporary.participant_name, "Temp")
        self.assertFalse(self.temporary.all_groups)
        self.assertEqual(group_names(self.temporary), [])
        self.assertEqual(
            Participant.groups.through.objects.filter(participant_id=self.temporary.pk).count(),
            0,
        )
        self.assertEqual(event_group_names(self.event), [])

    def test_stale_version_with_a_changed_group_cell_is_a_conflict(self):
        # An unchanged name used to slip a stale request through as a no-op;
        # the changed cell now makes it a conflict, and nothing is written.
        for expected_version, cell in ((0, "A"), (7, "ALL"), (2, "A; b")):
            with self.subTest(expected_version=expected_version, cell=cell):
                conflict = self.put(
                    {"name": "Temp", "expectedVersion": expected_version, "groupName": cell}
                )
                self.assertEqual(conflict.status_code, 409, conflict.data)
                self.assertIn("no-store", conflict["Cache-Control"])
                self.assertEqual(conflict.data["errorCode"], "participant_version_conflict")
                self.assertEqual(conflict.data["participant"]["version"], 1)
                self.assertIsNone(conflict.data["participant"]["group_name"])
                self.assertFalse(conflict.data["participant"]["allGroups"])
                self.assert_membership_untouched()

        # The same holds for a response field the organizer may fill in.
        response_conflict = self.put({"submitted": 0, "expectedVersion": 0, "groupName": "A"})
        self.assertEqual(response_conflict.status_code, 409, response_conflict.data)
        self.assertEqual(response_conflict.data["errorCode"], "participant_version_conflict")
        self.assert_membership_untouched()
        self.assert_results_revision_unchanged()

        # Retrying with the version the conflict reported applies the name and
        # the cell together, bumping the version exactly once.
        applied = self.put({"name": "Temp Renamed", "expectedVersion": 1, "groupName": "A; b"})
        self.assertEqual(applied.status_code, 200, applied.data)
        self.assertEqual(applied.data["participant"]["name"], "Temp Renamed")
        self.assertEqual(applied.data["participant"]["group_name"], "A; b")
        self.assertEqual(applied.data["participant"]["version"], 2)
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.participant_name, "Temp Renamed")
        self.assertEqual(self.temporary.version, 2)
        self.assertEqual(group_names(self.temporary), ["A", "b"])
        self.assertEqual(event_group_names(self.event), ["A", "b"])
        self.assert_results_revision_unchanged()

    def test_stale_version_with_an_unchanged_group_cell_is_still_a_no_op(self):
        # Without memberships, a blank cell (even one made of empty tokens)
        # changes nothing, so the stale version is ignored as before.
        for payload in (
            {"name": "Temp", "expectedVersion": 0, "groupName": ""},
            {"name": "Temp", "expectedVersion": 9, "groupName": " ; "},
            {"name": "Temp", "expectedVersion": 0},
        ):
            with self.subTest(payload=payload):
                unchanged = self.put(payload)
                self.assertEqual(unchanged.status_code, 200, unchanged.data)
                self.assertEqual(unchanged.data["participant"]["version"], 1)
                self.assertIsNone(unchanged.data["participant"]["group_name"])
                self.assert_membership_untouched()

        grouped = self.put({"groupName": "ALL; A; b"})
        self.assertEqual(grouped.status_code, 200, grouped.data)
        self.assertEqual(grouped.data["participant"]["version"], 2)

        # The current memberships in another order or case are the same cell.
        for cell in ("ALL; A; b", " b ;all; A ", "all; B; a; A"):
            with self.subTest(cell=cell):
                same = self.put({"name": "Temp", "expectedVersion": 1, "groupName": cell})
                self.assertEqual(same.status_code, 200, same.data)
                self.assertEqual(same.data["participant"]["version"], 2)
                self.assertEqual(same.data["participant"]["group_name"], "ALL; A; b")
                self.temporary.refresh_from_db()
                self.assertEqual(self.temporary.version, 2)
                self.assertTrue(self.temporary.all_groups)
                self.assertEqual(group_names(self.temporary), ["A", "b"])
        self.assertEqual(event_group_names(self.event), ["A", "b"])
        self.assert_results_revision_unchanged()

    def test_group_cell_may_list_at_most_one_hundred_names(self):
        too_many = self.put({"groupName": "; ".join([*HUNDRED_NAMES, "n101"])})
        self.assertEqual(too_many.status_code, 400)
        self.assertEqual(too_many.data, {"error": TOO_MANY_GROUPS})
        self.assert_membership_untouched()
        self.assert_results_revision_unchanged()

        # ALL and a repeated spelling do not count: this cell names 100 groups.
        at_limit = self.put({"groupName": "; ".join(["ALL", *HUNDRED_NAMES, "N001"])})
        self.assertEqual(at_limit.status_code, 200, at_limit.data)
        payload = at_limit.data["participant"]
        self.assertEqual(payload["version"], 2)
        self.assertTrue(payload["allGroups"])
        self.assertEqual([group["name"] for group in payload["groups"]], HUNDRED_NAMES)
        self.assertEqual(payload["group_name"], "; ".join(["ALL", *HUNDRED_NAMES]))
        self.assertEqual(event_group_names(self.event), HUNDRED_NAMES)
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.version, 2)
        self.assertEqual(group_names(self.temporary), HUNDRED_NAMES)
        self.assert_results_revision_unchanged()

    def test_closed_event_locks_group_edits_without_creating_groups(self):
        self.event.status = Event.Status.CLOSED
        self.event.closed_at = timezone.now()
        self.event.save(update_fields=["status", "closed_at", "updated_at"])

        locked = self.put({"groupName": "Z"})
        self.assertEqual(locked.status_code, 409, locked.data)
        self.assertEqual(
            locked.data,
            {
                "error": "Organizer-entered responses cannot change while the event is closed.",
                "errorCode": "participant_roster_locked",
            },
        )
        self.assertEqual(event_group_names(self.event), [])
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.version, 1)
        self.assertFalse(self.temporary.all_groups)

    def test_payload_without_recognized_fields_returns_the_unchanged_participant(self):
        response = self.put({"unknownKey": "ignored"})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["participant"]["id"], str(self.temporary.member_id))
        self.assertEqual(response.data["participant"]["version"], 1)
        self.assertIsNone(response.data["participant"]["group_name"])
        self.assertEqual(response.data["participant"]["groups"], [])
        self.assertFalse(response.data["participant"]["allGroups"])
        self.temporary.refresh_from_db()
        self.assertEqual(self.temporary.version, 1)
        self.assertEqual(event_group_names(self.event), [])
        self.assert_results_revision_unchanged()
