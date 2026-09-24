"""Participant groups: the group endpoints, the cell grammar, stats, and edits."""

import uuid
from unittest.mock import patch

from django.contrib import admin
from django.contrib.auth.models import Group, Permission
from django.db import IntegrityError, connection
from django.test import RequestFactory, TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient
from unfold.admin import ModelAdmin as UnfoldModelAdmin

from apps.authn.models import Member
from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.admin.participants import ParticipantAdmin, ParticipantGroupAdmin
from apps.scheduling.models import (
    Event,
    EventResultSnapshot,
    Participant,
    ParticipantGroup,
    UserEvent,
    Weight,
)
from apps.scheduling.services.roster_groups import (
    MAX_GROUPS_PER_CELL,
    _create_group,
    add_participant_groups,
    assign_memberships,
    create_group,
    delete_group,
    ensure_groups,
    format_group_cell,
    memberships_differ,
    parse_group_cell,
    remove_participant_groups,
    rename_group,
    set_participant_groups,
    update_memberships,
    validate_group_name,
    validate_group_names,
)
from apps.scheduling.services.roster_imports import RosterImportError
from apps.scheduling.views.roster.queries import roster_queryset, roster_stats

MEMBERSHIPS = Participant.groups.through
TOO_MANY_GROUPS = "group may list at most 100 names."


def membership_deletes(queries):
    """The captured DELETE statements that touch the membership table."""

    return [
        query["sql"]
        for query in queries
        if query["sql"].startswith("DELETE") and "participant_groups" in query["sql"]
    ]


def group_entry(group, count, weight):
    return {"id": group.pk, "name": group.name, "count": count, "weight": weight}


def ungrouped_entry(count, weight):
    return {"id": None, "name": "", "count": count, "weight": weight}


class RosterGroupTestCase(TestCase):
    """Shared fixtures: an organizer, an outsider, and a two-slot event."""

    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("owner@example.com", "Event", "Owner")
        self.outsider = create_member("outsider@example.com", "Other", "Person")
        self.event = self.create_event("GROUPS01", "Grouped event")
        self.participant_counter = 0
        self.authenticate(self.organizer)

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def create_event(self, code, name, *, organizer=None):
        organizer = organizer or self.organizer
        event = Event.objects.create(
            code=code,
            name=name,
            organizer=organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        UserEvent.objects.create(member=organizer, event=event, role="organizer")
        return event

    def add_participant(
        self,
        name,
        *,
        event=None,
        groups=(),
        all_groups=False,
        weight=None,
        included=True,
    ):
        event = event or self.event
        self.participant_counter += 1
        member = create_member(f"{name.lower()}-{self.participant_counter}@example.com", name)
        participant = Participant.objects.create(
            event=event,
            member=member,
            participant_name=name,
            availability_inperson=[0, 0],
            availability_virtual=[0, 0],
            all_groups=all_groups,
            sort_order=self.participant_counter,
        )
        if groups:
            participant.groups.set(ensure_groups(event=event, names=groups))
        if weight is not None:
            Weight.objects.create(
                event=event, participant=participant, weight=weight, included=included
            )
        return participant

    def group_names(self, participant):
        return sorted(participant.groups.values_list("name", flat=True))

    def versions(self, *participants):
        for participant in participants:
            participant.refresh_from_db()
        return tuple(participant.version for participant in participants)

    def groups_url(self, *, event=None, code=None):
        code = code if code is not None else (event or self.event).code
        return f"/events/roster/groups?code={code}"

    def group_url(self, group_id, *, event=None, code=None):
        code = code if code is not None else (event or self.event).code
        return f"/events/roster/groups/{group_id}?code={code}"

    def roster(self, query=""):
        response = self.client.get(f"/events/roster?code={self.event.code}&{query}")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def roster_names(self, query=""):
        return [row["name"] for row in self.roster(query)["participants"]]

    def patch_participant(self, participant, payload):
        participant.refresh_from_db()
        return self.client.patch(
            f"/events/roster/{participant.pk}?code={self.event.code}",
            {"expectedVersion": participant.version, **payload},
            format="json",
        )

    def bulk(self, selector, updates):
        return self.client.patch(
            f"/events/roster/bulk?code={self.event.code}",
            {**selector, "updates": updates, "idempotencyKey": str(uuid.uuid4())},
            format="json",
        )

    def bulk_queries(self, participants, updates):
        """Run a bulk edit that must change everyone; returns the captured queries."""

        ids = [participant.pk for participant in participants]
        with CaptureQueriesContext(connection) as captured:
            response = self.bulk({"participantIds": ids}, updates)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["updatedCount"], len(participants))
        return captured.captured_queries


class RosterGroupEndpointTests(RosterGroupTestCase):
    def test_get_lists_every_group_in_name_order_including_empty_ones(self):
        alpha = ParticipantGroup.objects.create(event=self.event, name="Alpha")
        beta = ParticipantGroup.objects.create(event=self.event, name="beta")
        zed = ParticipantGroup.objects.create(event=self.event, name="Zed")
        self.add_participant("One", groups=["Alpha"])
        self.add_participant("Two", groups=["Alpha"])
        self.add_participant("Three", groups=["beta"], weight=0.4)

        response = self.client.get(self.groups_url())

        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(
            response.data,
            {
                "groups": [
                    group_entry(alpha, 2, 1.0),
                    group_entry(beta, 1, 0.4),
                    group_entry(zed, 0, None),
                ]
            },
        )

    def test_post_creates_a_group_and_returns_the_full_list(self):
        alpha = ParticipantGroup.objects.create(event=self.event, name="Alpha")
        self.add_participant("One", groups=["Alpha"])

        response = self.client.post(self.groups_url(), {"name": "  Staff  "}, format="json")

        self.assertEqual(response.status_code, 201)
        staff = ParticipantGroup.objects.get(event=self.event, name="Staff")
        self.assertEqual(
            response.data,
            {
                "group": group_entry(staff, 0, None),
                "groups": [group_entry(alpha, 1, 1.0), group_entry(staff, 0, None)],
            },
        )

    def test_post_duplicate_name_is_refused_with_the_existing_spelling(self):
        ParticipantGroup.objects.create(event=self.event, name="Faculty")

        for name in ["faculty", "FACULTY", " Faculty "]:
            with self.subTest(name=name):
                response = self.client.post(self.groups_url(), {"name": name}, format="json")
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.data, {"error": "A group named Faculty already exists."})
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

    def test_post_rejects_reserved_blank_separator_and_long_names(self):
        cases = [
            ({"name": "ALL"}, "ALL is reserved for every group."),
            ({"name": "all"}, "ALL is reserved for every group."),
            ({"name": " aLl "}, "ALL is reserved for every group."),
            ({"name": "A;B"}, "Group names cannot contain ;."),
            ({"name": ""}, "Group name is required."),
            ({"name": "   "}, "Group name is required."),
            ({"name": None}, "Group name is required."),
            ({}, "Group name is required."),
            ({"name": "x" * 101}, "group is too long (max 100)."),
        ]
        for payload, message in cases:
            with self.subTest(payload=payload):
                response = self.client.post(self.groups_url(), payload, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data, {"error": message})
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event).exists())

        boundary = self.client.post(self.groups_url(), {"name": "y" * 100}, format="json")
        self.assertEqual(boundary.status_code, 201)
        self.assertEqual(boundary.data["group"]["name"], "y" * 100)

    def test_patch_renames_a_group_in_place(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")
        other = ParticipantGroup.objects.create(event=self.event, name="Other")
        one = self.add_participant("One", groups=["Staff"], weight=0.5)
        everywhere = self.add_participant("Everywhere", all_groups=True, weight=0.5)
        elsewhere = self.add_participant("Elsewhere", groups=["Other"])

        response = self.client.patch(self.group_url(staff.pk), {"name": " Team "}, format="json")

        self.assertEqual(response.status_code, 200)
        staff.refresh_from_db()
        self.assertEqual(staff.name, "Team")
        self.assertEqual(
            response.data,
            {
                "group": group_entry(staff, 2, 0.5),
                "groups": [group_entry(other, 2, None), group_entry(staff, 2, 0.5)],
            },
        )
        self.assertEqual(self.group_names(one), ["Team"])
        # The rename changes the group string of every member, explicit or via
        # ALL, so their versions move once; Elsewhere never showed the name.
        self.assertEqual(self.versions(one, everywhere, elsewhere), (2, 2, 1))

        cased = self.client.patch(self.group_url(staff.pk), {"name": "TEAM"}, format="json")
        self.assertEqual(cased.status_code, 200)
        self.assertEqual(cased.data["group"]["name"], "TEAM")
        # A case-only rename still rewrites the string everyone sees.
        self.assertEqual(self.versions(one, everywhere, elsewhere), (3, 3, 1))

        same = self.client.patch(self.group_url(staff.pk), {"name": " TEAM "}, format="json")
        self.assertEqual(same.status_code, 200)
        self.assertEqual(same.data["group"]["name"], "TEAM")
        # The identical name changes nothing, so nobody is bumped.
        self.assertEqual(self.versions(one, everywhere, elsewhere), (3, 3, 1))
        staff.refresh_from_db()
        self.assertEqual(staff.name, "TEAM")

    def test_patch_allows_a_case_only_rename_and_an_identical_name(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="staff")
        self.add_participant("One", groups=["staff"])

        response = self.client.patch(self.group_url(staff.pk), {"name": "Staff"}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["group"], group_entry(staff, 1, 1.0) | {"name": "Staff"})
        staff.refresh_from_db()
        self.assertEqual(staff.name, "Staff")

        same = self.client.patch(self.group_url(staff.pk), {"name": "Staff"}, format="json")
        self.assertEqual(same.status_code, 200)
        self.assertEqual(same.data["group"]["name"], "Staff")
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

    def test_patch_onto_another_groups_name_is_refused_and_never_merges(self):
        alpha = ParticipantGroup.objects.create(event=self.event, name="Alpha")
        beta = ParticipantGroup.objects.create(event=self.event, name="Beta")
        one = self.add_participant("One", groups=["Alpha"])
        two = self.add_participant("Two", groups=["Beta"])

        for name in ["Alpha", "alpha", " ALPHA "]:
            with self.subTest(name=name):
                response = self.client.patch(self.group_url(beta.pk), {"name": name}, format="json")
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.data, {"error": "A group named Alpha already exists."})

        beta.refresh_from_db()
        self.assertEqual(beta.name, "Beta")
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 2)
        self.assertEqual(self.group_names(one), ["Alpha"])
        self.assertEqual(self.group_names(two), ["Beta"])
        self.assertEqual(alpha.participants.count(), 1)

    def test_patch_rejects_invalid_names(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")
        cases = [
            ({"name": ""}, "Group name is required."),
            ({}, "Group name is required."),
            ({"name": "ALL"}, "ALL is reserved for every group."),
            ({"name": "a;b"}, "Group names cannot contain ;."),
            ({"name": "z" * 101}, "group is too long (max 100)."),
        ]
        for payload, message in cases:
            with self.subTest(payload=payload):
                response = self.client.patch(self.group_url(staff.pk), payload, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data, {"error": message})
        staff.refresh_from_db()
        self.assertEqual(staff.name, "Staff")

    def test_patch_and_delete_unknown_or_foreign_groups_are_404(self):
        other_event = self.create_event("GROUPS02", "Other event")
        foreign = ParticipantGroup.objects.create(event=other_event, name="Foreign")
        ParticipantGroup.objects.create(event=self.event, name="Local")

        for group_id in [999999, foreign.pk]:
            with self.subTest(group_id=group_id):
                patched = self.client.patch(
                    self.group_url(group_id), {"name": "Renamed"}, format="json"
                )
                self.assertEqual(patched.status_code, 404)
                self.assertEqual(patched.data, {"error": "Group not found"})
                deleted = self.client.delete(self.group_url(group_id))
                self.assertEqual(deleted.status_code, 404)
                self.assertEqual(deleted.data, {"error": "Group not found"})

        foreign.refresh_from_db()
        self.assertEqual(foreign.name, "Foreign")

    def test_delete_removes_the_group_and_its_memberships_but_keeps_people(self):
        alpha = ParticipantGroup.objects.create(event=self.event, name="Alpha")
        beta = ParticipantGroup.objects.create(event=self.event, name="Beta")
        one = self.add_participant("One", groups=["Alpha", "Beta"])
        two = self.add_participant("Two", groups=["Alpha"])
        everywhere = self.add_participant("Everywhere", all_groups=True)
        elsewhere = self.add_participant("Elsewhere", groups=["Beta"])
        self.assertEqual(MEMBERSHIPS.objects.filter(participantgroup=alpha).count(), 2)

        response = self.client.delete(self.group_url(alpha.pk))

        self.assertEqual(response.status_code, 200)
        # Two is left in no group, so the ungrouped row closes the list.
        self.assertEqual(
            response.data,
            {"groups": [group_entry(beta, 3, 1.0), ungrouped_entry(1, 1.0)]},
        )
        self.assertFalse(ParticipantGroup.objects.filter(pk=alpha.pk).exists())
        self.assertFalse(MEMBERSHIPS.objects.filter(participantgroup_id=alpha.pk).exists())
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 4)
        self.assertEqual(self.group_names(one), ["Beta"])
        self.assertEqual(self.group_names(two), [])
        self.assertEqual(self.group_names(elsewhere), ["Beta"])
        # Everyone whose group string listed Alpha, explicitly or through ALL,
        # is bumped exactly once; Elsewhere never listed it.
        self.assertEqual(self.versions(one, two, everywhere, elsewhere), (2, 2, 2, 1))

    def test_delete_surfaces_a_service_error(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")

        with patch(
            "apps.scheduling.views.roster.groups.delete_group",
            side_effect=RosterImportError("Group is locked.", status_code=409),
        ):
            response = self.client.delete(self.group_url(staff.pk))

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data, {"error": "Group is locked."})
        self.assertTrue(ParticipantGroup.objects.filter(pk=staff.pk).exists())

    def test_non_organizer_is_refused_on_every_group_endpoint(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")
        self.authenticate(self.outsider)
        calls = [
            ("get", self.groups_url(), None),
            ("post", self.groups_url(), {"name": "New"}),
            ("patch", self.group_url(staff.pk), {"name": "Renamed"}),
            ("delete", self.group_url(staff.pk), None),
        ]
        for method, url, payload in calls:
            with self.subTest(method=method):
                response = getattr(self.client, method)(url, payload, format="json")
                self.assertEqual(response.status_code, 403)
                self.assertEqual(
                    response.data, {"error": "Only the organizer can manage the roster"}
                )
        self.assertEqual(
            list(ParticipantGroup.objects.filter(event=self.event).values_list("name", flat=True)),
            ["Staff"],
        )

    def test_missing_and_unknown_event_codes(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")
        for code, status, message in [
            ("", 400, "code is required"),
            ("NOPE99", 404, "Event not found"),
        ]:
            calls = [
                ("get", self.groups_url(code=code), None),
                ("post", self.groups_url(code=code), {"name": "New"}),
                ("patch", self.group_url(staff.pk, code=code), {"name": "Renamed"}),
                ("delete", self.group_url(staff.pk, code=code), None),
            ]
            for method, url, payload in calls:
                with self.subTest(code=code, method=method):
                    response = getattr(self.client, method)(url, payload, format="json")
                    self.assertEqual(response.status_code, status)
                    self.assertEqual(response.data, {"error": message})

    def test_inactive_event_allows_reads_but_refuses_writes(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")
        for status in [Event.Status.CLOSED, Event.Status.FINALIZED]:
            self.event.status = status
            self.event.save(update_fields=["status", "updated_at"])
            message = f"Responses cannot change while the event is {status.value}."
            with self.subTest(status=status, method="get"):
                listed = self.client.get(self.groups_url())
                self.assertEqual(listed.status_code, 200)
                self.assertEqual(listed.data, {"groups": [group_entry(staff, 0, None)]})
            calls = [
                ("post", self.groups_url(), {"name": "New"}),
                ("patch", self.group_url(staff.pk), {"name": "Renamed"}),
                ("delete", self.group_url(staff.pk), None),
            ]
            for method, url, payload in calls:
                with self.subTest(status=status, method=method):
                    response = getattr(self.client, method)(url, payload, format="json")
                    self.assertEqual(response.status_code, 409)
                    self.assertEqual(response.data, {"error": message})
        self.assertEqual(
            list(ParticipantGroup.objects.filter(event=self.event).values_list("name", flat=True)),
            ["Staff"],
        )


class RosterGroupServiceTests(RosterGroupTestCase):
    def test_parse_group_cell(self):
        cases = [
            (None, (False, [])),
            ("", (False, [])),
            ("  ", (False, [])),
            (" ; ", (False, [])),
            ("ALL", (True, [])),
            ("all; a", (True, ["a"])),
            ("a;b", (False, ["a", "b"])),
            ("a; A; b", (False, ["a", "b"])),
            ("ALL; a", (True, ["a"])),
            (" a ;; ALL ; b ; All ", (True, ["a", "b"])),
        ]
        for cell, expected in cases:
            with self.subTest(cell=cell):
                self.assertEqual(parse_group_cell(cell), expected)

        with self.assertRaises(RosterImportError) as raised:
            parse_group_cell("a; " + "x" * 101)
        self.assertEqual(str(raised.exception), "group is too long (max 100).")
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(parse_group_cell("x" * 100), (False, ["x" * 100]))

    def test_parse_group_cell_rejects_values_that_are_not_strings(self):
        # A JSON list or number must not be stringified into a group name.
        for value in (["A"], {"name": "A"}, 5, True):
            with self.subTest(value=value):
                with self.assertRaises(RosterImportError) as raised:
                    parse_group_cell(value)
                self.assertEqual(str(raised.exception), "group must be a string.")

        person = self.add_participant("Typed")
        response = self.client.patch(
            f"/events/roster/{person.pk}?code={self.event.code}",
            {"expectedVersion": person.version, "group": ["A"]},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error"], "group must be a string.")
        bulk = self.client.patch(
            f"/events/roster/bulk?code={self.event.code}",
            {
                "participantIds": [str(person.pk)],
                "updates": {"group": 5},
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(bulk.status_code, 400)
        self.assertEqual(bulk.data["error"], "group must be a string.")
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event).exists())

    def test_format_group_cell(self):
        self.assertEqual(format_group_cell(True, []), "ALL")
        self.assertEqual(format_group_cell(True, ["A", "B"]), "ALL; A; B")
        self.assertEqual(format_group_cell(False, ["A"]), "A")
        self.assertEqual(format_group_cell(False, []), "")
        self.assertEqual(format_group_cell(False, ("A", "B")), "A; B")

    def test_validate_group_name(self):
        self.assertEqual(validate_group_name("  Staff  "), "Staff")
        self.assertEqual(validate_group_name("x" * 100), "x" * 100)
        cases = [
            (None, "Group name is required."),
            ("", "Group name is required."),
            ("   ", "Group name is required."),
            ("ALL", "ALL is reserved for every group."),
            ("all", "ALL is reserved for every group."),
            ("a;b", "Group names cannot contain ;."),
            (";", "Group names cannot contain ;."),
            ("x" * 101, "group is too long (max 100)."),
        ]
        for name, message in cases:
            with self.subTest(name=name):
                with self.assertRaises(RosterImportError) as raised:
                    validate_group_name(name)
                self.assertEqual(str(raised.exception), message)
                self.assertEqual(raised.exception.status_code, 400)

    def test_remove_participant_groups(self):
        one = self.add_participant("One", groups=["Alpha", "Beta"])

        for names in [["Nope"], [""], [None], ["  "], [], ["Nope", None, ""]]:
            with self.subTest(names=names):
                self.assertFalse(remove_participant_groups(participant=one, names=names))
        self.assertEqual(self.group_names(one), ["Alpha", "Beta"])
        # Unknown names are never turned into groups.
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 2)

        self.assertTrue(remove_participant_groups(participant=one, names=[" aLPHA "]))
        self.assertEqual(self.group_names(one), ["Beta"])
        self.assertFalse(remove_participant_groups(participant=one, names=["alpha"]))
        self.assertTrue(remove_participant_groups(participant=one, names=["Beta", "Nope"]))
        self.assertEqual(self.group_names(one), [])
        # The groups themselves survive; only the memberships go.
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 2)

    def test_add_participant_groups(self):
        one = self.add_participant("One", groups=["Alpha"])

        self.assertFalse(add_participant_groups(participant=one, names=["alpha"]))
        self.assertFalse(add_participant_groups(participant=one, names=[]))
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

        self.assertTrue(add_participant_groups(participant=one, names=["Beta", " ALPHA "]))
        self.assertEqual(self.group_names(one), ["Alpha", "Beta"])
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 2)

        with self.assertRaises(RosterImportError) as raised:
            add_participant_groups(participant=one, names=["ALL"])
        self.assertEqual(str(raised.exception), "ALL is reserved for every group.")

    def test_set_participant_groups(self):
        one = self.add_participant("One", groups=["Alpha"], all_groups=True)

        self.assertFalse(set_participant_groups(participant=one, all_groups=True, names=["alpha"]))
        one.refresh_from_db()
        self.assertTrue(one.all_groups)
        self.assertEqual(self.group_names(one), ["Alpha"])

        self.assertTrue(set_participant_groups(participant=one, all_groups=False, names=["Alpha"]))
        one.refresh_from_db()
        self.assertFalse(one.all_groups)
        self.assertEqual(self.group_names(one), ["Alpha"])

        self.assertTrue(set_participant_groups(participant=one, all_groups=False, names=["Beta"]))
        one.refresh_from_db()
        self.assertEqual(self.group_names(one), ["Beta"])
        self.assertTrue(set_participant_groups(participant=one, all_groups=False, names=[]))
        self.assertEqual(self.group_names(one), [])
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 2)

    def test_update_memberships_with_no_participants_is_a_no_op(self):
        self.assertEqual(
            update_memberships(
                event=self.event,
                participants=[],
                replace=(True, ["Alpha"]),
                add=["Beta"],
                remove=["Gamma"],
                all_groups=True,
            ),
            set(),
        )
        self.assertEqual(
            update_memberships(event=self.event, participants=iter(())),
            set(),
        )
        # No groups are created for a selection that matched nobody.
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event).exists())

    def test_update_memberships_explicit_flag_wins_over_the_cell(self):
        one = self.add_participant("One", groups=["Alpha"], all_groups=True)
        two = self.add_participant("Two", groups=["Beta"])

        changed = update_memberships(
            event=self.event,
            participants=[one, two],
            replace=(True, ["Gamma", "Beta"]),
            add=["Delta"],
            remove=["gamma", "Nope", None, ""],
            all_groups=False,
        )

        self.assertEqual(changed, {one.pk, two.pk})
        for participant in (one, two):
            self.assertFalse(participant.all_groups)
            participant.refresh_from_db()
            self.assertFalse(participant.all_groups)
            self.assertEqual(self.group_names(participant), ["Beta", "Delta"])
        self.assertEqual(
            sorted(
                ParticipantGroup.objects.filter(event=self.event).values_list("name", flat=True)
            ),
            ["Alpha", "Beta", "Delta", "Gamma"],
        )

        # The same edit again changes nobody.
        self.assertEqual(
            update_memberships(
                event=self.event,
                participants=[one, two],
                replace=(False, ["Beta", "Delta"]),
            ),
            set(),
        )

    def test_assign_memberships(self):
        self.assertEqual(assign_memberships(event=self.event, assignments=[]), set())
        self.assertEqual(assign_memberships(event=self.event, assignments=iter(())), set())
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event).exists())

        one = self.add_participant("One", groups=["Alpha"])
        two = self.add_participant("Two")
        three = self.add_participant("Three", all_groups=True)

        changed = assign_memberships(
            event=self.event,
            assignments=[
                (one, (False, ["alpha"])),
                (two, (True, ["Beta", "Alpha"])),
                (three, (False, [])),
            ],
        )

        self.assertEqual(changed, {two.pk, three.pk})
        self.assertEqual(self.group_names(one), ["Alpha"])
        self.assertEqual(self.group_names(two), ["Alpha", "Beta"])
        two.refresh_from_db()
        three.refresh_from_db()
        self.assertTrue(two.all_groups)
        self.assertFalse(three.all_groups)
        self.assertEqual(
            sorted(
                ParticipantGroup.objects.filter(event=self.event).values_list("name", flat=True)
            ),
            ["Alpha", "Beta"],
        )
        self.assertEqual(
            assign_memberships(
                event=self.event,
                assignments=[(one, (False, ["Alpha"])), (two, (True, ["Alpha", "Beta"]))],
            ),
            set(),
        )

    def test_rename_group_with_the_identical_name_leaves_the_row_alone(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")
        stamp = staff.updated_at

        for name in ["Staff", "  Staff  "]:
            with self.subTest(name=name):
                renamed = rename_group(group=staff, name=name)
                self.assertIs(renamed, staff)
                self.assertEqual(renamed.name, "Staff")
        staff.refresh_from_db()
        self.assertEqual(staff.updated_at, stamp)

        renamed = rename_group(group=staff, name="Team")
        self.assertIs(renamed, staff)
        staff.refresh_from_db()
        self.assertEqual(staff.name, "Team")
        self.assertGreater(staff.updated_at, stamp)

    def test_ensure_groups_reuses_case_variants(self):
        faculty = ParticipantGroup.objects.create(event=self.event, name="Faculty")

        groups = ensure_groups(
            event=self.event, names=["faculty", " FACULTY ", "Students", "students"]
        )

        self.assertEqual([group.pk for group in groups[:2]], [faculty.pk, faculty.pk])
        self.assertEqual(groups[2].name, "Students")
        self.assertEqual(groups[3].pk, groups[2].pk)
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 2)
        self.assertEqual(ensure_groups(event=self.event, names=[]), [])

        with self.assertRaises(RosterImportError) as raised:
            ensure_groups(event=self.event, names=["Fine", "ALL"])
        self.assertEqual(str(raised.exception), "ALL is reserved for every group.")
        # The whole batch rolls back when one name is invalid.
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 2)

    def test_ensure_groups_falls_back_to_the_database_lookup(self):
        # The Python-side key misses the row (the database folds case
        # differently), so the LOWER() lookup has to find it instead.
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")

        with patch(
            "apps.scheduling.services.roster_groups._find_group", return_value=staff
        ) as find_group:
            groups = ensure_groups(event=self.event, names=["Team", " team "])

        find_group.assert_called_once_with(self.event, "Team")
        self.assertEqual(groups, [staff, staff])
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

    def test_create_group_helper_returns_the_row_that_won_the_insert(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")

        with patch(
            "apps.scheduling.models.ParticipantGroup.objects.create",
            side_effect=IntegrityError("one_group_name_per_event"),
        ) as create:
            group, created = _create_group(self.event, "STAFF")

        create.assert_called_once_with(event=self.event, name="STAFF")
        self.assertEqual((group, created), (staff, False))
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

    def test_create_group_helper_survives_a_real_constraint_violation(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")

        self.assertEqual(_create_group(self.event, "staff"), (staff, False))

        # The savepoint kept the surrounding transaction usable.
        team, created = _create_group(self.event, "Team")
        self.assertTrue(created)
        self.assertEqual(team.name, "Team")
        self.assertEqual(
            list(ParticipantGroup.objects.filter(event=self.event).values_list("name", flat=True)),
            ["Staff", "Team"],
        )

    def test_create_group_helper_re_raises_when_no_row_owns_the_name(self):
        with patch(
            "apps.scheduling.models.ParticipantGroup.objects.create",
            side_effect=IntegrityError("participant_group_event_fk"),
        ):
            with self.assertRaises(IntegrityError):
                _create_group(self.event, "Nobody")
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event).exists())

    def test_create_group_refuses_a_row_that_appeared_during_the_insert(self):
        # A concurrent writer's row that the pre-insert lookup could not see.
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")

        with patch(
            "apps.scheduling.services.roster_groups._create_group", return_value=(staff, False)
        ) as helper:
            with self.assertRaises(RosterImportError) as raised:
                create_group(event=self.event, name="Team")

        helper.assert_called_once_with(self.event, "Team")
        self.assertEqual(str(raised.exception), "A group named Staff already exists.")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event, name="Team").exists())

        # The same race through the real constraint: the first lookup misses,
        # the insert collides, and the second lookup names the winner.
        with patch("apps.scheduling.services.roster_groups._find_group", side_effect=[None, staff]):
            with self.assertRaises(RosterImportError) as raised:
                create_group(event=self.event, name="staff")
        self.assertEqual(str(raised.exception), "A group named Staff already exists.")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

    def test_rename_group_refuses_a_clash_the_database_catches(self):
        staff = ParticipantGroup.objects.create(event=self.event, name="Staff")
        one = self.add_participant("One", groups=["Staff"])

        with patch(
            "apps.scheduling.models.ParticipantGroup.save",
            side_effect=IntegrityError("one_group_name_per_event"),
        ):
            with self.assertRaises(RosterImportError) as raised:
                rename_group(group=staff, name="Team")

        self.assertEqual(str(raised.exception), "A group named Team already exists.")
        self.assertEqual(raised.exception.status_code, 409)
        # The in-memory name is restored, and nobody's version moved.
        self.assertEqual(staff.name, "Staff")
        staff.refresh_from_db()
        self.assertEqual(staff.name, "Staff")
        self.assertEqual(self.versions(one), (1,))

        # A real collision names the row that owns the spelling.
        team = ParticipantGroup.objects.create(event=self.event, name="TEAM")
        with patch("apps.scheduling.services.roster_groups._find_group", side_effect=[None, team]):
            with self.assertRaises(RosterImportError) as raised:
                rename_group(group=staff, name="team")
        self.assertEqual(str(raised.exception), "A group named TEAM already exists.")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(staff.name, "Staff")
        self.assertEqual(
            list(ParticipantGroup.objects.filter(event=self.event).values_list("name", flat=True)),
            ["Staff", "TEAM"],
        )
        self.assertEqual(self.versions(one), (1,))

    def test_memberships_differ(self):
        one = self.add_participant("One", groups=["Alpha", "Beta"])
        everywhere = self.add_participant("Everywhere", all_groups=True)
        loose = self.add_participant("Loose")

        same = [
            (one, False, ["Alpha", "Beta"]),
            (one, False, ["Beta", "Alpha"]),
            (one, False, [" beta ", "ALPHA", "alpha"]),
            (one, False, ("Alpha", "Beta")),
            (everywhere, True, []),
            (loose, False, []),
            (loose, 0, ()),
        ]
        for participant, all_groups, names in same:
            with self.subTest(participant=participant.participant_name, names=names):
                self.assertFalse(
                    memberships_differ(participant=participant, all_groups=all_groups, names=names)
                )

        different = [
            (one, True, ["Alpha", "Beta"]),
            (one, False, ["Alpha"]),
            (one, False, ["Alpha", "Beta", "Gamma"]),
            (one, False, ["Alpha", "Bet"]),
            (one, False, []),
            (everywhere, False, []),
            (everywhere, True, ["Alpha"]),
            (loose, True, []),
            (loose, False, ["Alpha"]),
        ]
        for participant, all_groups, names in different:
            with self.subTest(participant=participant.participant_name, names=names):
                self.assertTrue(
                    memberships_differ(participant=participant, all_groups=all_groups, names=names)
                )

    def test_validate_group_names_dedupes_and_caps_the_list(self):
        self.assertEqual(validate_group_names([" A ", "a", "B", "b ", "A"]), ["A", "B"])
        self.assertEqual(validate_group_names([]), [])
        self.assertEqual(validate_group_names(("Solo",)), ["Solo"])

        self.assertEqual(MAX_GROUPS_PER_CELL, 100)
        names = [f"g{index}" for index in range(101)]
        self.assertEqual(validate_group_names(names[:100]), names[:100])
        with self.assertRaises(RosterImportError) as raised:
            validate_group_names(names)
        self.assertEqual(str(raised.exception), TOO_MANY_GROUPS)
        self.assertEqual(raised.exception.status_code, 400)
        # The cap guards the payload size, so it counts entries before deduping.
        with self.assertRaises(RosterImportError) as raised:
            validate_group_names(["Same"] * 101)
        self.assertEqual(str(raised.exception), TOO_MANY_GROUPS)

        for names, message in [
            (["A", "ALL"], "ALL is reserved for every group."),
            (["A", ""], "Group name is required."),
            (["A", None], "Group name is required."),
            (["a;b"], "Group names cannot contain ;."),
            (["A", "x" * 101], "group is too long (max 100)."),
        ]:
            with self.subTest(names=names):
                with self.assertRaises(RosterImportError) as raised:
                    validate_group_names(names)
                self.assertEqual(str(raised.exception), message)

    def test_parse_group_cell_caps_distinct_names_only(self):
        names = [f"g{index}" for index in range(100)]
        self.assertEqual(parse_group_cell("; ".join(names)), (False, names))
        # ALL is a flag, not a name, so it never counts toward the cap.
        self.assertEqual(parse_group_cell("ALL; " + "; ".join(names)), (True, names))

        with self.assertRaises(RosterImportError) as raised:
            parse_group_cell("; ".join([*names, "g100"]))
        self.assertEqual(str(raised.exception), TOO_MANY_GROUPS)
        self.assertEqual(raised.exception.status_code, 400)

        # Repeated spellings collapse before the count, so 150 tokens can fit.
        tokens = [*names, *(name.upper() for name in names[:50])]
        self.assertEqual(len(tokens), 150)
        self.assertEqual(parse_group_cell("; ".join(tokens)), (False, names))


class RosterGroupStatsTests(RosterGroupTestCase):
    def test_person_in_two_groups_counts_in_both(self):
        one = self.add_participant("One", groups=["Alpha", "Beta"])
        alpha = ParticipantGroup.objects.get(event=self.event, name="Alpha")
        beta = ParticipantGroup.objects.get(event=self.event, name="Beta")

        data = self.roster()

        self.assertEqual(
            data["stats"]["groups"], [group_entry(alpha, 1, 1.0), group_entry(beta, 1, 1.0)]
        )
        self.assertEqual(data["stats"]["total"], 1)
        row = data["participants"][0]
        self.assertEqual(row["id"], str(one.pk))
        self.assertEqual(row["group"], "Alpha; Beta")
        self.assertEqual(
            row["groups"],
            [{"id": alpha.pk, "name": "Alpha"}, {"id": beta.pk, "name": "Beta"}],
        )
        self.assertFalse(row["allGroups"])
        self.assertEqual(self.roster_names("group=Alpha"), ["One"])
        self.assertEqual(self.roster_names("group=beta"), ["One"])

    def test_all_groups_person_counts_in_every_group_including_later_ones(self):
        self.add_participant("One", groups=["Alpha"])
        self.add_participant("Everywhere", all_groups=True, weight=0.5)
        alpha = ParticipantGroup.objects.get(event=self.event, name="Alpha")
        beta = ParticipantGroup.objects.create(event=self.event, name="Beta")

        data = self.roster()
        self.assertEqual(
            data["stats"]["groups"], [group_entry(alpha, 2, None), group_entry(beta, 1, 0.5)]
        )
        everywhere = data["participants"][1]
        self.assertEqual(everywhere["group"], "ALL")
        self.assertEqual(everywhere["groups"], [])
        self.assertTrue(everywhere["allGroups"])

        created = self.client.post(self.groups_url(), {"name": "Gamma"}, format="json")
        self.assertEqual(created.status_code, 201)
        gamma = ParticipantGroup.objects.get(event=self.event, name="Gamma")
        self.assertEqual(created.data["group"], group_entry(gamma, 1, 0.5))
        self.assertEqual(
            created.data["groups"],
            [group_entry(alpha, 2, None), group_entry(beta, 1, 0.5), group_entry(gamma, 1, 0.5)],
        )

        self.assertEqual(self.roster_names("group=Alpha"), ["One", "Everywhere"])
        for query in ["group=Beta", "group=gamma", "group=%20Gamma%20", "group=Unknown"]:
            with self.subTest(query=query):
                self.assertEqual(self.roster_names(query), ["Everywhere"])
        # Nobody is ungrouped, so no ungrouped row and no match for the filter.
        self.assertNotIn(None, [entry["id"] for entry in self.roster()["stats"]["groups"]])
        self.assertEqual(self.roster_names("group=__ungrouped__"), [])

    def test_ungrouped_filter_and_row_cover_only_people_in_no_group(self):
        one = self.add_participant("One", groups=["Alpha"])
        self.add_participant("Everywhere", all_groups=True)
        loose = self.add_participant("Loose", weight=0.25)
        alpha = ParticipantGroup.objects.get(event=self.event, name="Alpha")

        data = self.roster("group=__ungrouped__")
        self.assertEqual([row["name"] for row in data["participants"]], ["Loose"])
        self.assertEqual(data["pagination"]["total"], 1)
        # The group list always describes the whole roster, filter or not.
        self.assertEqual(
            data["stats"]["groups"], [group_entry(alpha, 2, 1.0), ungrouped_entry(1, 0.25)]
        )
        loose_row = data["participants"][0]
        self.assertEqual(loose_row["group"], "")
        self.assertEqual(loose_row["groups"], [])
        self.assertFalse(loose_row["allGroups"])

        loose.groups.add(alpha)
        self.assertEqual(self.roster_names("group=__ungrouped__"), [])
        self.assertEqual(self.roster()["stats"]["groups"], [group_entry(alpha, 3, None)])

        one.groups.clear()
        # A blank group filter is ignored rather than treated as ungrouped.
        self.assertEqual(self.roster_names("group="), ["One", "Everywhere", "Loose"])
        self.assertEqual(self.roster_names("group=__ungrouped__"), ["One"])
        self.assertEqual(
            self.roster()["stats"]["groups"], [group_entry(alpha, 2, None), ungrouped_entry(1, 1.0)]
        )

    def test_search_matches_group_names(self):
        self.add_participant("Alice", groups=["Faculty"])
        self.add_participant("Bob", groups=["Students"])
        self.add_participant("Carol", all_groups=True)

        self.assertEqual(self.roster_names("search=facul"), ["Alice"])
        self.assertEqual(self.roster_names("search=STUD"), ["Bob"])
        self.assertEqual(self.roster_names("search=Ali"), ["Alice"])
        # The ALL flag is not a name, so a search never reaches Carol via it.
        self.assertEqual(self.roster_names("search=all"), [])
        self.assertEqual(self.roster_names("search=t"), ["Alice", "Bob"])
        self.assertEqual(self.roster_names("search=t&group=Students"), ["Bob"])

    def test_group_weight_is_shared_or_none_when_mixed(self):
        self.add_participant("One", groups=["Alpha", "Beta"], weight=0.5)
        self.add_participant("Two", groups=["Alpha"], weight=0.5)
        self.add_participant("Three", groups=["Beta"])
        self.add_participant("Four", groups=["Gamma"], weight=0.5, included=False)
        empty = ParticipantGroup.objects.create(event=self.event, name="Empty")
        alpha = ParticipantGroup.objects.get(event=self.event, name="Alpha")
        beta = ParticipantGroup.objects.get(event=self.event, name="Beta")
        gamma = ParticipantGroup.objects.get(event=self.event, name="Gamma")

        self.assertEqual(
            self.roster()["stats"]["groups"],
            [
                group_entry(alpha, 2, 0.5),
                group_entry(beta, 2, None),
                group_entry(empty, 0, None),
                group_entry(gamma, 1, 0.5),
            ],
        )

    def test_participant_group_strings_cover_every_shape(self):
        self.add_participant("Single", groups=["A"])
        self.add_participant("Pair", groups=["A", "B"])
        self.add_participant("Everywhere", all_groups=True)
        self.add_participant("Both", groups=["A"], all_groups=True)
        self.add_participant("None")
        a = ParticipantGroup.objects.get(event=self.event, name="A")
        b = ParticipantGroup.objects.get(event=self.event, name="B")

        rows = self.roster()["participants"]

        self.assertEqual(
            [(row["name"], row["group"], row["groups"], row["allGroups"]) for row in rows],
            [
                ("Single", "A", [{"id": a.pk, "name": "A"}], False),
                ("Pair", "A; B", [{"id": a.pk, "name": "A"}, {"id": b.pk, "name": "B"}], False),
                ("Everywhere", "ALL", [], True),
                ("Both", "ALL; A", [{"id": a.pk, "name": "A"}], True),
                ("None", "", [], False),
            ],
        )
        self.assertEqual(self.roster_names("group=A"), ["Single", "Pair", "Everywhere", "Both"])
        self.assertEqual(self.roster_names("group=B"), ["Pair", "Everywhere", "Both"])
        self.assertEqual(self.roster_names("group=__ungrouped__"), ["None"])

    def test_roster_stats_defaults_to_the_filtered_queryset(self):
        self.add_participant("One", groups=["Alpha"])
        self.add_participant("Two", groups=["Beta"], weight=0.5)
        alpha = ParticipantGroup.objects.get(event=self.event, name="Alpha")
        beta = ParticipantGroup.objects.get(event=self.event, name="Beta")
        queryset = roster_queryset(self.event).filter(participant_name="One")

        stats = roster_stats(self.event, queryset)

        # Memberships of people outside the queryset are not counted.
        self.assertEqual(stats["groups"], [group_entry(alpha, 1, 1.0), group_entry(beta, 0, None)])
        self.assertEqual(stats["total"], 1)
        whole = roster_stats(self.event, queryset, groups_queryset=roster_queryset(self.event))
        self.assertEqual(whole["groups"], [group_entry(alpha, 1, 1.0), group_entry(beta, 1, 0.5)])
        self.assertEqual(whole["total"], 1)


class RosterParticipantGroupPatchTests(RosterGroupTestCase):
    def test_group_cell_creates_missing_groups_and_sets_both(self):
        one = self.add_participant("One")

        response = self.patch_participant(one, {"group": "A; B"})

        self.assertEqual(response.status_code, 200)
        a = ParticipantGroup.objects.get(event=self.event, name="A")
        b = ParticipantGroup.objects.get(event=self.event, name="B")
        participant = response.data["participant"]
        self.assertEqual(participant["group"], "A; B")
        self.assertEqual(
            participant["groups"], [{"id": a.pk, "name": "A"}, {"id": b.pk, "name": "B"}]
        )
        self.assertFalse(participant["allGroups"])
        self.assertEqual(participant["version"], 2)
        self.assertEqual(response.data["resultsRevision"], 1)
        self.assertEqual(response.data["groups"], [group_entry(a, 1, 1.0), group_entry(b, 1, 1.0)])
        one.refresh_from_db()
        self.assertEqual(one.version, 2)
        self.assertEqual(self.group_names(one), ["A", "B"])
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 1)
        self.assertFalse(EventResultSnapshot.objects.filter(event=self.event).exists())

    def test_groups_array_and_all_groups_flag(self):
        one = self.add_participant("One", groups=["Old"])

        response = self.patch_participant(one, {"groups": ["A"], "allGroups": True})

        self.assertEqual(response.status_code, 200)
        a = ParticipantGroup.objects.get(event=self.event, name="A")
        participant = response.data["participant"]
        self.assertEqual(participant["group"], "ALL; A")
        self.assertEqual(participant["groups"], [{"id": a.pk, "name": "A"}])
        self.assertTrue(participant["allGroups"])
        one.refresh_from_db()
        self.assertTrue(one.all_groups)
        self.assertEqual(self.group_names(one), ["A"])

        # Duplicate spellings collapse onto the first one.
        deduped = self.patch_participant(one, {"groups": [" B ", "b", "A", "C"]})
        self.assertEqual(deduped.status_code, 200)
        self.assertEqual(deduped.data["participant"]["group"], "ALL; A; B; C")
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 4)

        cleared_flag = self.patch_participant(one, {"allGroups": False})
        self.assertEqual(cleared_flag.status_code, 200)
        self.assertEqual(cleared_flag.data["participant"]["group"], "A; B; C")
        self.assertFalse(cleared_flag.data["participant"]["allGroups"])

    def test_groups_array_validation(self):
        one = self.add_participant("One", groups=["A"])
        cases = [
            ({"groups": "x"}, "groups must be an array of group names."),
            ({"groups": ["A", 1]}, "groups must be an array of group names."),
            ({"groups": None}, "groups must be an array of group names."),
            ({"groups": ["ALL"]}, "ALL is reserved for every group."),
            ({"groups": [""]}, "Group name is required."),
            ({"groups": ["a;b"]}, "Group names cannot contain ;."),
            ({"groups": ["x" * 101]}, "group is too long (max 100)."),
            ({"group": "B; " + "x" * 101}, "group is too long (max 100)."),
            ({"allGroups": "maybe"}, "allGroups must be true or false."),
            ({"allGroups": None}, "allGroups must be true or false."),
        ]
        for payload, message in cases:
            with self.subTest(payload=payload):
                response = self.patch_participant(one, payload)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data, {"error": message})
        one.refresh_from_db()
        self.assertEqual(one.version, 1)
        self.assertEqual(self.group_names(one), ["A"])
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

        coerced = self.patch_participant(one, {"allGroups": "yes"})
        self.assertEqual(coerced.status_code, 200)
        self.assertTrue(coerced.data["participant"]["allGroups"])
        self.assertEqual(coerced.data["participant"]["group"], "ALL; A")

    def test_groups_array_and_cell_are_capped_at_one_hundred_names(self):
        one = self.add_participant("One", groups=["A"])
        names = [f"g{index}" for index in range(101)]

        for payload in [{"groups": names}, {"group": "; ".join(names)}]:
            with self.subTest(key=next(iter(payload))):
                response = self.patch_participant(one, payload)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data, {"error": TOO_MANY_GROUPS})
        self.assertEqual(self.group_names(one), ["A"])
        self.assertEqual(self.versions(one), (1,))
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

        accepted = self.patch_participant(one, {"groups": names[:100]})
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(len(accepted.data["participant"]["groups"]), 100)
        self.assertEqual(self.versions(one), (2,))
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 101)

    def test_group_ids_add_and_remove_single_memberships(self):
        one = self.add_participant("One", groups=["A"])
        a = ParticipantGroup.objects.get(event=self.event, name="A")
        b = create_group(event=self.event, name="B")
        c = create_group(event=self.event, name="C")

        added = self.patch_participant(one, {"addGroupIds": [b.pk, c.pk, b.pk]})
        self.assertEqual(added.status_code, 200, added.data)
        self.assertEqual(added.data["participant"]["group"], "A; B; C")
        self.assertEqual(added.data["participant"]["version"], 2)
        self.assertEqual(
            added.data["groups"],
            [group_entry(a, 1, 1.0), group_entry(b, 1, 1.0), group_entry(c, 1, 1.0)],
        )

        # Re-adding a membership or dropping one the person lacks is a no-op.
        for payload in [{"addGroupIds": [a.pk]}, {"removeGroupIds": []}]:
            with self.subTest(payload=payload):
                unchanged = self.patch_participant(one, payload)
                self.assertEqual(unchanged.status_code, 200, unchanged.data)
                self.assertEqual(unchanged.data["participant"]["version"], 2)

        removed = self.patch_participant(one, {"removeGroupIds": [a.pk]})
        self.assertEqual(removed.data["participant"]["group"], "B; C")
        self.assertEqual(removed.data["participant"]["version"], 3)

        # Adds land before removes, and neither touches the every-group flag.
        both = self.patch_participant(
            one, {"allGroups": True, "addGroupIds": [a.pk], "removeGroupIds": [b.pk, c.pk]}
        )
        self.assertEqual(both.status_code, 200, both.data)
        self.assertEqual(both.data["participant"]["group"], "ALL; A")
        self.assertEqual(self.group_names(one), ["A"])

    def test_group_ids_refuse_a_deleted_group_instead_of_recreating_it(self):
        one = self.add_participant("One", groups=["A"])
        gone = create_group(event=self.event, name="Gone")
        gone_id = gone.pk
        delete_group(group=gone)
        foreign = create_group(event=self.create_event("GROUPS02", "Other event"), name="Foreign")

        for group_id in (gone_id, foreign.pk):
            with self.subTest(group_id=group_id):
                refused = self.patch_participant(one, {"addGroupIds": [group_id]})
                self.assertEqual(refused.status_code, 409, refused.data)
                self.assertEqual(
                    refused.data, {"error": "This group was deleted in another session."}
                )
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event, name="Gone").exists())
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event, name="Foreign").exists())
        self.assertEqual(self.versions(one), (1,))

        # Leaving a group that is already gone has nothing left to do.
        left = self.patch_participant(one, {"removeGroupIds": [gone_id]})
        self.assertEqual(left.status_code, 200, left.data)
        self.assertEqual(left.data["participant"]["group"], "A")
        self.assertEqual(self.versions(one), (1,))

    def test_group_id_lists_are_validated(self):
        one = self.add_participant("One", groups=["A"])
        for key in ("addGroupIds", "removeGroupIds"):
            for value in ("1", [1, "2"], [True], None, list(range(1, MAX_GROUPS_PER_CELL + 2))):
                with self.subTest(key=key, value=value):
                    response = self.patch_participant(one, {key: value})
                    self.assertEqual(response.status_code, 400, response.data)
                    self.assertEqual(
                        response.data, {"error": f"{key} must be an array of group ids."}
                    )
        self.assertEqual(self.versions(one), (1,))
        self.assertEqual(self.group_names(one), ["A"])

    def test_blank_cell_clears_memberships_and_the_flag(self):
        one = self.add_participant("One", groups=["A"], all_groups=True)
        a = ParticipantGroup.objects.get(event=self.event, name="A")

        response = self.patch_participant(one, {"group": ""})

        self.assertEqual(response.status_code, 200)
        participant = response.data["participant"]
        self.assertEqual((participant["group"], participant["groups"]), ("", []))
        self.assertFalse(participant["allGroups"])
        self.assertEqual(participant["version"], 2)
        one.refresh_from_db()
        self.assertFalse(one.all_groups)
        self.assertEqual(self.group_names(one), [])
        # The group row outlives its last member; the person is now ungrouped.
        self.assertEqual(
            response.data["groups"], [group_entry(a, 0, None), ungrouped_entry(1, 1.0)]
        )

    def test_identical_resend_and_group_name_alias(self):
        one = self.add_participant("One", groups=["A"])

        for payload in [{"group": "A"}, {"group": " a "}, {"groups": ["A"]}, {"allGroups": False}]:
            with self.subTest(payload=payload):
                response = self.patch_participant(one, payload)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data["participant"]["version"], 1)
                self.assertEqual(response.data["participant"]["group"], "A")
        one.refresh_from_db()
        self.assertEqual(one.version, 1)

        aliased = self.patch_participant(one, {"groupName": "B"})
        self.assertEqual(aliased.status_code, 200)
        b = ParticipantGroup.objects.get(event=self.event, name="B")
        self.assertEqual(aliased.data["participant"]["group"], "B")
        self.assertEqual(aliased.data["participant"]["groups"], [{"id": b.pk, "name": "B"}])
        self.assertEqual(aliased.data["participant"]["version"], 2)
        self.assertEqual(aliased.data["resultsRevision"], 1)
        self.assertEqual(self.group_names(one), ["B"])

    def test_groups_and_flag_override_the_cell(self):
        one = self.add_participant("One", groups=["Old"], all_groups=False)

        response = self.patch_participant(one, {"group": "ALL; X", "groups": ["Y"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["participant"]["group"], "ALL; Y")
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event, name="X").exists())

        response = self.patch_participant(one, {"group": "ALL; X", "allGroups": False})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["participant"]["group"], "X")

        # Without a cell, the missing half comes from the person's current state.
        response = self.patch_participant(one, {"allGroups": True})
        self.assertEqual(response.data["participant"]["group"], "ALL; X")
        response = self.patch_participant(one, {"groups": ["Z"]})
        self.assertEqual(response.data["participant"]["group"], "ALL; Z")
        response = self.patch_participant(one, {"groups": []})
        self.assertEqual(response.data["participant"]["group"], "ALL")
        self.assertEqual(response.data["participant"]["groups"], [])

    def test_group_and_weight_edit_together_bumps_results_once(self):
        one = self.add_participant("One")

        response = self.patch_participant(one, {"group": "A", "weight": 0.5})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["participant"]["group"], "A")
        self.assertEqual(response.data["participant"]["weight"], 0.5)
        self.assertEqual(response.data["participant"]["version"], 2)
        self.assertEqual(response.data["resultsRevision"], 2)
        a = ParticipantGroup.objects.get(event=self.event, name="A")
        self.assertEqual(response.data["groups"], [group_entry(a, 1, 0.5)])


class RosterBulkGroupTests(RosterGroupTestCase):
    def test_add_groups_keeps_other_memberships_and_creates_missing(self):
        one = self.add_participant("One", groups=["A"])
        two = self.add_participant("Two", groups=["B"])

        response = self.bulk({"participantIds": [one.pk]}, {"addGroups": [" b ", "New", "new"]})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data,
            {"updatedCount": 1, "matchedCount": 1, "resultsRevision": 1, "idempotent": False},
        )
        self.assertEqual(self.group_names(one), ["A", "B", "New"])
        self.assertEqual(self.group_names(two), ["B"])
        self.assertEqual(
            sorted(
                ParticipantGroup.objects.filter(event=self.event).values_list("name", flat=True)
            ),
            ["A", "B", "New"],
        )
        one.refresh_from_db()
        two.refresh_from_db()
        self.assertEqual((one.version, two.version), (2, 1))
        self.assertFalse(EventResultSnapshot.objects.filter(event=self.event).exists())

    def test_remove_groups_removes_only_the_named_one_and_ignores_unknown(self):
        one = self.add_participant("One", groups=["A", "B"])

        response = self.bulk({"participantIds": [one.pk]}, {"removeGroups": [" a ", "Nope", ""]})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["updatedCount"], 1)
        self.assertEqual(response.data["resultsRevision"], 1)
        self.assertEqual(self.group_names(one), ["B"])
        self.assertFalse(ParticipantGroup.objects.filter(event=self.event, name="Nope").exists())
        self.assertTrue(ParticipantGroup.objects.filter(event=self.event, name="A").exists())

        again = self.bulk({"participantIds": [one.pk]}, {"removeGroups": ["Nope", "a"]})
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.data["updatedCount"], 0)
        self.assertEqual(again.data["matchedCount"], 1)
        one.refresh_from_db()
        self.assertEqual(one.version, 2)

    def test_all_groups_true_and_false(self):
        one = self.add_participant("One", groups=["A"])
        two = self.add_participant("Two", groups=["B"], all_groups=True)
        selector = {"participantIds": [one.pk, two.pk]}

        flagged = self.bulk(selector, {"allGroups": True})
        self.assertEqual(flagged.status_code, 200)
        self.assertEqual((flagged.data["updatedCount"], flagged.data["matchedCount"]), (1, 2))
        one.refresh_from_db()
        two.refresh_from_db()
        self.assertTrue(one.all_groups)
        self.assertTrue(two.all_groups)
        self.assertEqual((one.version, two.version), (2, 1))
        self.assertEqual(self.group_names(one), ["A"])

        cleared = self.bulk(selector, {"allGroups": "false"})
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual((cleared.data["updatedCount"], cleared.data["matchedCount"]), (2, 2))
        one.refresh_from_db()
        two.refresh_from_db()
        self.assertFalse(one.all_groups)
        self.assertFalse(two.all_groups)
        self.assertEqual(self.group_names(two), ["B"])
        self.assertEqual(cleared.data["resultsRevision"], 1)

    def test_blank_group_clears_memberships_and_the_flag(self):
        one = self.add_participant("One", groups=["A"], all_groups=True)
        two = self.add_participant("Two", groups=["B"])

        response = self.bulk({"participantIds": [one.pk, two.pk]}, {"group": ""})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["updatedCount"], 2)
        one.refresh_from_db()
        two.refresh_from_db()
        self.assertFalse(one.all_groups)
        self.assertEqual(self.group_names(one), [])
        self.assertEqual(self.group_names(two), [])
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 2)

        aliased = self.bulk({"participantIds": [one.pk]}, {"groupName": "ALL; C"})
        self.assertEqual(aliased.status_code, 200)
        one.refresh_from_db()
        self.assertTrue(one.all_groups)
        self.assertEqual(self.group_names(one), ["C"])

        # An explicit flag wins over the cell's ALL token.
        overridden = self.bulk(
            {"participantIds": [one.pk]}, {"group": "ALL; D", "allGroups": False}
        )
        self.assertEqual(overridden.status_code, 200)
        one.refresh_from_db()
        self.assertFalse(one.all_groups)
        self.assertEqual(self.group_names(one), ["D"])

    def test_group_update_validation(self):
        one = self.add_participant("One", groups=["A"])
        cases = [
            ({"addGroups": "A"}, "addGroups must be an array of group names."),
            ({"addGroups": ["A", 5]}, "addGroups must be an array of group names."),
            ({"addGroups": None}, "addGroups must be an array of group names."),
            ({"addGroups": ["ALL"]}, "ALL is reserved for every group."),
            ({"addGroups": [""]}, "Group name is required."),
            ({"addGroups": ["a;b"]}, "Group names cannot contain ;."),
            ({"removeGroups": "A"}, "removeGroups must be an array of group names."),
            ({"removeGroups": [1]}, "removeGroups must be an array of group names."),
            ({"allGroups": "maybe"}, "allGroups must be true or false."),
            ({"group": "x" * 101}, "group is too long (max 100)."),
        ]
        for updates, message in cases:
            with self.subTest(updates=updates):
                response = self.bulk({"participantIds": [one.pk]}, updates)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data, {"error": message})
        one.refresh_from_db()
        self.assertEqual(one.version, 1)
        self.assertEqual(self.group_names(one), ["A"])
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

    def test_group_lists_are_capped_at_one_hundred_names(self):
        one = self.add_participant("One", groups=["A"])
        names = [f"g{index}" for index in range(101)]

        for updates in [
            {"addGroups": names},
            {"removeGroups": names},
            {"group": "; ".join(names)},
        ]:
            with self.subTest(key=next(iter(updates))):
                response = self.bulk({"participantIds": [one.pk]}, updates)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data, {"error": TOO_MANY_GROUPS})
        self.assertEqual(self.group_names(one), ["A"])
        self.assertEqual(self.versions(one), (1,))
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

        # Exactly one hundred unknown names to remove is fine and changes nobody.
        boundary = self.bulk({"participantIds": [one.pk]}, {"removeGroups": names[:100]})
        self.assertEqual(boundary.status_code, 200)
        self.assertEqual((boundary.data["updatedCount"], boundary.data["matchedCount"]), (0, 1))
        self.assertEqual(ParticipantGroup.objects.filter(event=self.event).count(), 1)

    def test_add_groups_collapses_case_variants_onto_one_group(self):
        one = self.add_participant("One")

        response = self.bulk({"participantIds": [one.pk]}, {"addGroups": ["A", "a"]})

        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.data["updatedCount"], response.data["matchedCount"]), (1, 1))
        # The first spelling wins and only one membership row is written.
        self.assertEqual(
            list(ParticipantGroup.objects.filter(event=self.event).values_list("name", flat=True)),
            ["A"],
        )
        self.assertEqual(self.group_names(one), ["A"])
        self.assertEqual(MEMBERSHIPS.objects.filter(participant=one).count(), 1)

    def test_dropping_memberships_runs_one_delete_whatever_the_selection_size(self):
        ParticipantGroup.objects.create(event=self.event, name="Other")
        bystander = self.add_participant("Bystander", groups=["A"])
        cases = [
            ({"group": ""}, []),
            ({"removeGroups": ["A"]}, []),
            ({"group": "Other"}, ["Other"]),
        ]
        for updates, expected in cases:
            with self.subTest(updates=updates):
                few = [self.add_participant("Few", groups=["A"]) for _ in range(5)]
                many = [self.add_participant("Many", groups=["A"]) for _ in range(30)]

                few_queries = self.bulk_queries(few, updates)
                many_queries = self.bulk_queries(many, updates)

                deletes = membership_deletes(many_queries)
                self.assertEqual(len(deletes), 1, deletes)
                # The dropped rows go by their own primary keys, not per person.
                self.assertIn('"scheduling_participant_groups"."id" IN (', deletes[0])
                self.assertEqual(len(membership_deletes(few_queries)), 1)
                # Nothing in the request scales with the number of people.
                self.assertEqual(len(few_queries), len(many_queries))
                for participant in [*few, *many]:
                    self.assertEqual(self.group_names(participant), expected)
                self.assertEqual(self.group_names(bystander), ["A"])

    def test_group_selector_includes_all_groups_people(self):
        one = self.add_participant("One", groups=["A"])
        everywhere = self.add_participant("Everywhere", all_groups=True)
        two = self.add_participant("Two", groups=["B"])

        response = self.bulk({"group": " a "}, {"addGroups": ["C"]})

        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.data["updatedCount"], response.data["matchedCount"]), (2, 2))
        self.assertEqual(self.group_names(one), ["A", "C"])
        self.assertEqual(self.group_names(everywhere), ["C"])
        self.assertEqual(self.group_names(two), ["B"])
        everywhere.refresh_from_db()
        self.assertTrue(everywhere.all_groups)

        filtered = self.bulk({"filter": {"group": "B"}}, {"removeGroups": ["B"]})
        self.assertEqual(filtered.status_code, 200)
        self.assertEqual((filtered.data["updatedCount"], filtered.data["matchedCount"]), (1, 2))
        self.assertEqual(self.group_names(two), [])

    def test_blank_group_selector_selects_only_ungrouped_people(self):
        one = self.add_participant("One", groups=["A"])
        everywhere = self.add_participant("Everywhere", all_groups=True)
        loose = self.add_participant("Loose")

        for selector in [{"group": ""}, {"group": "   "}, {"group": None}]:
            with self.subTest(selector=selector):
                response = self.bulk(selector, {"allGroups": False})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data["matchedCount"], 1)
                self.assertEqual(response.data["updatedCount"], 0)

        response = self.bulk({"group": ""}, {"addGroups": ["Fresh"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.data["updatedCount"], response.data["matchedCount"]), (1, 1))
        self.assertEqual(self.group_names(loose), ["Fresh"])
        self.assertEqual(self.group_names(one), ["A"])
        self.assertEqual(self.group_names(everywhere), [])
        # Nobody is ungrouped any more.
        empty = self.bulk({"group": ""}, {"addGroups": ["Fresh"]})
        self.assertEqual(empty.status_code, 200)
        self.assertEqual((empty.data["updatedCount"], empty.data["matchedCount"]), (0, 0))

    def test_membership_only_edits_count_changed_people_only(self):
        one = self.add_participant("One", groups=["A"])
        two = self.add_participant("Two", groups=["A", "B"])

        response = self.bulk({"participantIds": [one.pk, two.pk]}, {"addGroups": ["B"]})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data,
            {"updatedCount": 1, "matchedCount": 2, "resultsRevision": 1, "idempotent": False},
        )
        one.refresh_from_db()
        two.refresh_from_db()
        self.assertEqual((one.version, two.version), (2, 1))
        self.assertEqual(self.group_names(one), ["A", "B"])
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 1)
        self.assertFalse(EventResultSnapshot.objects.filter(event=self.event).exists())


class RosterGroupWeightTests(RosterGroupTestCase):
    def test_group_weight_applies_to_every_member_including_multi_group_people(self):
        person = self.add_participant("Person", groups=["A", "B"])
        # Second already carries a weight row; Person's is created by the edit.
        second = self.add_participant("Second", groups=["A"], weight=1.0)
        third = self.add_participant("Third", groups=["B"])
        a = ParticipantGroup.objects.get(event=self.event, name="A")
        b = ParticipantGroup.objects.get(event=self.event, name="B")
        self.assertEqual(
            self.roster()["stats"]["groups"], [group_entry(a, 2, 1.0), group_entry(b, 2, 1.0)]
        )

        response = self.bulk({"group": "A"}, {"weight": 0.6})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data,
            {"updatedCount": 2, "matchedCount": 2, "resultsRevision": 2, "idempotent": False},
        )
        self.assertEqual(
            {
                weight.participant_id: (weight.weight, weight.included)
                for weight in Weight.objects.filter(event=self.event)
            },
            {person.pk: (0.6, True), second.pk: (0.6, True)},
        )
        third.refresh_from_db()
        self.assertEqual(third.version, 1)
        # A shares 0.6; B mixes Person's 0.6 with Third's default 1.0.
        self.assertEqual(
            self.roster()["stats"]["groups"], [group_entry(a, 2, 0.6), group_entry(b, 2, None)]
        )
        self.assertEqual(self.group_names(person), ["A", "B"])

        # Re-sending the same weight changes nobody and leaves results alone.
        again = self.bulk({"group": "A"}, {"weight": 0.6})
        self.assertEqual(again.status_code, 200)
        self.assertEqual(
            again.data,
            {"updatedCount": 0, "matchedCount": 2, "resultsRevision": 2, "idempotent": False},
        )


class ParticipantUpdateGroupNameTests(RosterGroupTestCase):
    def update_url(self, participant):
        return (
            f"/events/participants/update?code={self.event.code}"
            f"&participantId={participant.member_id}"
        )

    def test_organizer_sets_a_group_cell(self):
        one = self.add_participant("One", groups=["Old"])

        response = self.client.put(self.update_url(one), {"groupName": "ALL; A"}, format="json")

        self.assertEqual(response.status_code, 200)
        a = ParticipantGroup.objects.get(event=self.event, name="A")
        participant = response.data["participant"]
        self.assertEqual(participant["group_name"], "ALL; A")
        self.assertEqual(participant["groups"], [{"id": a.pk, "name": "A"}])
        self.assertTrue(participant["allGroups"])
        self.assertEqual(participant["version"], 2)
        one.refresh_from_db()
        self.assertTrue(one.all_groups)
        self.assertEqual(self.group_names(one), ["A"])
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 1)

        again = self.client.put(self.update_url(one), {"groupName": "all; a"}, format="json")
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.data["participant"]["version"], 2)

        cleared = self.client.put(self.update_url(one), {"groupName": ""}, format="json")
        self.assertEqual(cleared.status_code, 200)
        self.assertIsNone(cleared.data["participant"]["group_name"])
        self.assertEqual(cleared.data["participant"]["groups"], [])
        self.assertFalse(cleared.data["participant"]["allGroups"])
        self.assertEqual(cleared.data["participant"]["version"], 3)

    def test_invalid_cell_and_non_organizer(self):
        one = self.add_participant("One", groups=["A"])

        invalid = self.client.put(self.update_url(one), {"groupName": "x" * 101}, format="json")
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.data, {"error": "group is too long (max 100)."})

        self.authenticate(one.member)
        forbidden = self.client.put(self.update_url(one), {"groupName": "B"}, format="json")
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(forbidden.data["errorCode"], "participant_update_forbidden")
        self.assertEqual(self.group_names(one), ["A"])
        one.refresh_from_db()
        self.assertEqual(one.version, 1)


class ParticipantGroupAdminTests(RosterGroupTestCase):
    def test_group_names_joins_memberships(self):
        participant_admin = admin.site._registry[Participant]
        self.assertIsInstance(participant_admin, ParticipantAdmin)
        pair = self.add_participant("Pair", groups=["beta", "Alpha"])
        alone = self.add_participant("Alone", all_groups=True)

        self.assertEqual(participant_admin.group_names(pair), "Alpha; beta")
        self.assertEqual(participant_admin.group_names(alone), "")

    def test_member_count(self):
        group_admin = admin.site._registry[ParticipantGroup]
        self.assertIsInstance(group_admin, ParticipantGroupAdmin)
        self.add_participant("One", groups=["Alpha"])
        self.add_participant("Two", groups=["Alpha", "Beta"])
        self.add_participant("Everywhere", all_groups=True)

        alpha = ParticipantGroup.objects.get(event=self.event, name="Alpha")
        beta = ParticipantGroup.objects.get(event=self.event, name="Beta")
        empty = ParticipantGroup.objects.create(event=self.event, name="Empty")
        # Explicit memberships only; the ALL flag is not a through row.
        self.assertEqual(group_admin.member_count(alpha), 2)
        self.assertEqual(group_admin.member_count(beta), 1)
        self.assertEqual(group_admin.member_count(empty), 0)

    def test_get_queryset_prefetches_groups(self):
        participant_admin = ParticipantAdmin(Participant, admin.site)
        superuser = Member.objects.create_superuser(
            password="AdminPass123!", first_name="Site", last_name="Admin"
        )
        one = self.add_participant("One", groups=["Alpha", "Beta"])
        two = self.add_participant("Two")
        request = RequestFactory().get("/admin/scheduling/participant/")
        request.user = superuser

        queryset = participant_admin.get_queryset(request)

        self.assertEqual(set(queryset.values_list("pk", flat=True)), {one.pk, two.pk})
        # One query for the rows and one for the prefetched memberships.
        with self.assertNumQueries(2):
            names = [participant_admin.group_names(row) for row in queryset]
        self.assertEqual(sorted(names), ["", "Alpha; Beta"])

    def admin_request(self, path, user):
        request = RequestFactory().get(path)
        request.user = user
        return request

    def superuser(self):
        return Member.objects.create_superuser(
            password="AdminPass123!", first_name="Site", last_name="Admin"
        )

    def test_get_form_remembers_the_participant_and_scopes_the_groups_field(self):
        participant_admin = ParticipantAdmin(Participant, admin.site)
        other_event = self.create_event("GROUPS02", "Other event")
        local = ParticipantGroup.objects.create(event=self.event, name="Local")
        ParticipantGroup.objects.create(event=other_event, name="Foreign")
        one = self.add_participant("One", groups=["Local"])
        user = self.superuser()

        change_request = self.admin_request(f"/admin/scheduling/participant/{one.pk}/change/", user)
        change_form = participant_admin.get_form(change_request, one, change=True)

        self.assertIs(change_request._participant_admin_obj, one)
        self.assertEqual(list(change_form.base_fields["groups"].queryset), [local])

        # The add form has no participant yet, so no event to draw groups from.
        add_request = self.admin_request("/admin/scheduling/participant/add/", user)
        add_form = participant_admin.get_form(add_request)

        self.assertIsNone(add_request._participant_admin_obj)
        self.assertEqual(list(add_form.base_fields["groups"].queryset), [])

    def test_formfield_for_manytomany_limits_groups_to_the_participants_event(self):
        participant_admin = ParticipantAdmin(Participant, admin.site)
        other_event = self.create_event("GROUPS02", "Other event")
        local = ParticipantGroup.objects.create(event=self.event, name="Local")
        also_local = ParticipantGroup.objects.create(event=self.event, name="Also local")
        ParticipantGroup.objects.create(event=other_event, name="Foreign")
        one = self.add_participant("One")
        abroad = self.add_participant("Abroad", event=other_event)
        groups_field = Participant._meta.get_field("groups")
        request = self.admin_request("/admin/scheduling/participant/add/", self.superuser())

        request._participant_admin_obj = one
        formfield = participant_admin.formfield_for_manytomany(groups_field, request)
        self.assertEqual(list(formfield.queryset), [also_local, local])

        request._participant_admin_obj = abroad
        formfield = participant_admin.formfield_for_manytomany(groups_field, request)
        self.assertEqual([group.name for group in formfield.queryset], ["Foreign"])

        # No participant (the add form) and a request that never went through
        # get_form both offer nothing rather than every event's groups.
        request._participant_admin_obj = None
        formfield = participant_admin.formfield_for_manytomany(groups_field, request)
        self.assertEqual(list(formfield.queryset), [])
        bare = self.admin_request("/admin/scheduling/participant/add/", request.user)
        formfield = participant_admin.formfield_for_manytomany(groups_field, bare)
        self.assertEqual(list(formfield.queryset), [])

    def test_formfield_for_manytomany_leaves_other_fields_alone(self):
        participant_admin = ParticipantAdmin(Participant, admin.site)
        one = self.add_participant("One", groups=["Local"])
        request = self.admin_request("/admin/scheduling/participant/add/", self.superuser())
        request._participant_admin_obj = one
        permissions = Group._meta.get_field("permissions")

        formfield = participant_admin.formfield_for_manytomany(permissions, request)

        self.assertIs(formfield.queryset.model, Permission)
        self.assertEqual(formfield.queryset.count(), Permission.objects.count())
        self.assertGreater(formfield.queryset.count(), 0)

        # The call reaches the base admin with its arguments untouched.
        with patch.object(UnfoldModelAdmin, "formfield_for_manytomany") as base:
            result = participant_admin.formfield_for_manytomany(
                permissions, request, widget="custom"
            )
        self.assertIs(result, base.return_value)
        base.assert_called_once_with(permissions, request, widget="custom")

        with patch.object(UnfoldModelAdmin, "formfield_for_manytomany") as base:
            participant_admin.formfield_for_manytomany(
                Participant._meta.get_field("groups"), request
            )
        _args, kwargs = base.call_args
        self.assertEqual([group.name for group in kwargs["queryset"]], ["Local"])
