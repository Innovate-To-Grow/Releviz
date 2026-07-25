from datetime import UTC, datetime

from django.test import TestCase
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.aggregation import (
    build_event_results,
    parse_availability,
    participant_availability,
    participant_has_valid_submission,
    participant_is_excluded,
    result_channels,
)
from apps.scheduling.models import Event, Participant, Weight
from apps.scheduling.permissions import (
    can_view_event_results,
    canonical_view_permission,
    participant_for_user,
    visible_participants_for_user,
    weight_for_participant,
)


class AggregationDomainTests(TestCase):
    def setUp(self):
        self.organizer = create_member("organizer-results@example.com", "Org", "Owner")
        self.event = Event.objects.create(
            code="RESULTS1",
            name="Results",
            organizer=self.organizer,
            mode="mixed",
            start_minutes=9 * 60,
            end_minutes=9 * 60 + 15,
            slot_minutes=15,
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20", "2026-07-21"],
        )

    def add_participant(
        self,
        email,
        *,
        inperson=(0, 0),
        virtual=(0, 0),
        submitted=False,
        hidden=False,
    ):
        member = create_member(email)
        return Participant.objects.create(
            event=self.event,
            member=member,
            participant_name=member.display_name(),
            availability_inperson=list(inperson),
            availability_virtual=list(virtual),
            submitted=submitted,
            hidden=hidden,
        )

    def test_official_results_exclude_unsubmitted_hidden_excluded_and_invalid_responses(self):
        required = self.add_participant(
            "required@example.com",
            inperson=(1, 0),
            virtual=(0.5, 1),
            submitted=True,
        )
        other = self.add_participant(
            "other@example.com",
            inperson=(0, 1),
            virtual=(1, 0.5),
            submitted=True,
        )
        unanswered = self.add_participant("unanswered@example.com")
        hidden = self.add_participant(
            "hidden@example.com",
            inperson=(1, 1),
            virtual=(1, 1),
            submitted=True,
            hidden=True,
        )
        excluded = self.add_participant(
            "excluded@example.com",
            inperson=(1, 1),
            virtual=(1, 1),
            submitted=True,
        )
        invalid = self.add_participant(
            "invalid@example.com",
            inperson=(1,),
            virtual=(1, 1),
            submitted=True,
        )
        Weight.objects.create(
            event=self.event,
            participant=required,
            weight=0.5,
            required=True,
        )
        Weight.objects.create(event=self.event, participant=other, weight=1.0)
        Weight.objects.create(
            event=self.event,
            participant=unanswered,
            required=True,
        )
        Weight.objects.create(
            event=self.event,
            participant=hidden,
            weight=1.0,
        )
        Weight.objects.create(
            event=self.event,
            participant=excluded,
            included=False,
            required=True,
        )
        Weight.objects.create(
            event=self.event,
            participant=invalid,
            required=True,
        )

        results = build_event_results(
            self.event,
            now=datetime(2026, 7, 16, 12, tzinfo=UTC),
        )

        self.assertEqual(results["countedResponseTotal"], 2)
        self.assertEqual(results["unansweredParticipantTotal"], 1)
        self.assertEqual(results["excludedParticipantTotal"], 3)
        self.assertEqual(
            results["exclusionReasons"],
            {"hidden": 1, "organizerExcluded": 1, "invalidResponse": 1},
        )
        self.assertEqual(results["calculationBasis"]["unweighted"], {"participantTotal": 2})
        self.assertEqual(
            results["calculationBasis"]["weighted"],
            {"participantTotal": 2, "totalWeight": 1.5},
        )
        self.assertEqual(results["channels"]["inperson"]["unweighted"], [0.5, 0.5])
        self.assertEqual(results["channels"]["inperson"]["weighted"], [0.3333, 0.6667])
        self.assertEqual(results["channels"]["virtual"]["unweighted"], [0.75, 0.75])
        self.assertEqual(results["channels"]["virtual"]["weighted"], [0.8333, 0.6667])
        self.assertEqual(
            results["requiredParticipantConflicts"],
            {
                "unansweredRequiredParticipantTotal": 1,
                "excludedRequiredParticipantTotal": 2,
                "channels": {
                    "inperson": [{"slotIndex": 1, "requiredParticipantTotal": 1}],
                    "virtual": [],
                },
            },
        )
        self.assertEqual(
            [
                (
                    recommendation["rank"],
                    recommendation["channel"],
                    recommendation["slotIndex"],
                    recommendation["requiredParticipantConflictTotal"],
                    recommendation["weightedAvailability"],
                )
                for recommendation in results["recommendations"]
            ],
            [
                (1, "virtual", 0, 3, 0.8333),
                (2, "virtual", 1, 3, 0.6667),
                (3, "inperson", 0, 3, 0.3333),
                (4, "inperson", 1, 4, 0.6667),
            ],
        )
        self.assertEqual(
            results["recommendations"][0],
            {
                "channel": "virtual",
                "slotIndex": 0,
                "groupKey": "date:2026-07-20",
                "groupLabel": "2026-07-20",
                "weekday": None,
                "date": "2026-07-20",
                "localStart": "09:00",
                "localEnd": "09:15",
                "startDayOffset": 0,
                "endDayOffset": 0,
                "suggestedStartsAt": "2026-07-20T09:00:00+00:00",
                "suggestedEndsAt": "2026-07-20T09:15:00+00:00",
                "label": "2026-07-20 09:00–09:15",
                "weightedAvailability": 0.8333,
                "unweightedAvailability": 0.75,
                "fullyAvailableParticipantTotal": 1,
                "partiallyAvailableParticipantTotal": 1,
                "unavailableParticipantTotal": 0,
                "requiredParticipantConflictTotal": 3,
                "rank": 1,
            },
        )
        self.assertEqual(results["recommendationBasis"]["status"], "ready")
        self.assertEqual(
            results["recommendationBasis"]["order"][0],
            "fewestRequiredParticipantConflicts",
        )

    def test_channel_parsing_validity_and_empty_or_zero_weight_results(self):
        inperson_event = Event.objects.create(
            code="INPERSON",
            name="In person",
            organizer=self.organizer,
            mode="inperson",
            start_minutes=9 * 60,
            end_minutes=10 * 60 + 45,
            slot_minutes=15,
            days=[1],
        )
        virtual_event = Event.objects.create(
            code="VIRTUAL",
            name="Virtual",
            organizer=self.organizer,
            mode="virtual",
            start_minutes=9 * 60,
            end_minutes=10 * 60 + 45,
            slot_minutes=15,
            days=[1],
        )
        self.assertEqual(result_channels(inperson_event), ("inperson",))
        self.assertEqual(result_channels(virtual_event), ("virtual",))
        self.assertEqual(result_channels(self.event), ("inperson", "virtual"))

        self.assertEqual(parse_availability([0.25, 0.75], 2), [0.25, 0.75])
        for value, length in [
            ("[0, 1]", 2),
            ("[bad", 2),
            (object(), 2),
            ({"slot": 1}, 2),
            ([1], 2),
            ([True, 0], 2),
            (["1", 0], 2),
            ([-0.1, 0], 2),
            ([1.1, 0], 2),
        ]:
            with self.subTest(value=value):
                self.assertIsNone(parse_availability(value, length))

        member = create_member("zero-weight@example.com")
        participant = Participant.objects.create(
            event=virtual_event,
            member=member,
            participant_name="Zero",
            availability_inperson=[0] * 7,
            availability_virtual=[1] * 7,
            submitted=True,
        )
        weight = Weight.objects.create(
            event=virtual_event,
            participant=participant,
            weight=0,
        )
        results = build_event_results(virtual_event)
        self.assertEqual(results["channels"]["virtual"]["unweighted"], [1.0] * 7)
        self.assertEqual(results["channels"]["virtual"]["weighted"], [0.0] * 7)
        self.assertEqual(
            results["calculationBasis"]["weighted"],
            {"participantTotal": 0, "totalWeight": 0.0},
        )
        self.assertTrue(participant_has_valid_submission(participant, virtual_event))
        self.assertFalse(participant_is_excluded(participant, weight))

        participant.submitted = False
        self.assertFalse(participant_has_valid_submission(participant, virtual_event))
        participant.submitted = True
        participant.availability_virtual = "[1]"
        self.assertIsNone(participant_availability(participant, virtual_event))
        self.assertFalse(participant_has_valid_submission(participant, virtual_event))

        participant.hidden = True
        self.assertTrue(participant_is_excluded(participant, weight))
        participant.hidden = False
        weight.included = False
        self.assertTrue(participant_is_excluded(participant, weight))
        self.assertFalse(participant_is_excluded(participant))

        empty_results = build_event_results(inperson_event)
        self.assertEqual(empty_results["countedResponseTotal"], 0)
        self.assertEqual(empty_results["channels"]["inperson"]["unweighted"], [0.0] * 7)
        self.assertEqual(empty_results["channels"]["inperson"]["weighted"], [0.0] * 7)
        self.assertEqual(empty_results["recommendations"], [])
        self.assertEqual(
            empty_results["recommendationBasis"]["status"],
            "waiting_for_submissions",
        )


class SchedulingPermissionTests(TestCase):
    def setUp(self):
        self.organizer = create_member("organizer-access@example.com", "Org", "Owner")
        self.first = create_member("first-access@example.com", "First", "Person")
        self.second = create_member("second-access@example.com", "Second", "Person")
        self.unsubmitted = create_member("draft-access@example.com", "Draft", "Person")
        self.hidden_member = create_member("hidden-access@example.com", "Hidden", "Person")
        self.excluded_member = create_member("excluded-access@example.com", "Excluded", "Person")
        self.invalid_member = create_member("invalid-access@example.com", "Invalid", "Person")
        self.unrelated = create_member("unrelated-access@example.com", "Unrelated", "Person")
        self.event = Event.objects.create(
            code="ACCESS1",
            name="Access",
            organizer=self.organizer,
            mode="inperson",
            start_minutes=9 * 60,
            end_minutes=10 * 60 + 45,
            slot_minutes=15,
            days=[1],
            participant_view_permission="own_only",
        )
        self.participants = {}
        for member, submitted, hidden, values in [
            (self.first, True, False, [1] * 7),
            (self.second, True, False, [0.5] * 7),
            (self.unsubmitted, False, False, [0] * 7),
            (self.hidden_member, True, True, [1] * 7),
            (self.excluded_member, True, False, [1] * 7),
            (self.invalid_member, True, False, [1]),
        ]:
            self.participants[member.pk] = Participant.objects.create(
                event=self.event,
                member=member,
                participant_name=member.display_name(),
                availability_inperson=values,
                availability_virtual=[0] * 7,
                submitted=submitted,
                hidden=hidden,
            )
        Weight.objects.create(
            event=self.event,
            participant=self.participants[self.excluded_member.pk],
            included=False,
        )

    def ids(self, participants):
        return {participant.member_id for participant in participants}

    def test_permission_modes_and_excluded_participant_semantics(self):
        self.assertEqual(canonical_view_permission(self.event), "own_only")
        self.event.participant_view_permission = "all"
        self.assertEqual(canonical_view_permission(self.event), "all_after_submit")
        self.event.participant_view_permission = "own_only"

        first_participant = participant_for_user(self.event, self.first)
        self.assertEqual(first_participant, self.participants[self.first.pk])
        self.assertIsNone(participant_for_user(self.event, self.unrelated))
        self.assertIsNone(weight_for_participant(self.event, first_participant))
        self.assertIsNotNone(
            weight_for_participant(
                self.event,
                self.participants[self.excluded_member.pk],
            )
        )

        organizer_visible = visible_participants_for_user(self.event, self.organizer)
        self.assertNotIn(self.hidden_member.pk, self.ids(organizer_visible))
        organizer_all = visible_participants_for_user(
            self.event,
            self.organizer,
            include_hidden=True,
        )
        self.assertIn(self.hidden_member.pk, self.ids(organizer_all))
        self.assertTrue(can_view_event_results(self.event, self.organizer))

        self.assertIsNone(visible_participants_for_user(self.event, self.unrelated))
        self.assertFalse(can_view_event_results(self.event, self.unrelated))
        self.assertEqual(
            self.ids(visible_participants_for_user(self.event, self.first)),
            {self.first.pk},
        )
        self.assertFalse(can_view_event_results(self.event, self.first))

        self.event.participant_view_permission = "all_after_submit"
        self.event.save(update_fields=["participant_view_permission"])
        self.assertEqual(
            self.ids(visible_participants_for_user(self.event, self.unsubmitted)),
            {self.unsubmitted.pk},
        )
        self.assertFalse(can_view_event_results(self.event, self.unsubmitted))
        self.assertEqual(
            self.ids(visible_participants_for_user(self.event, self.first)),
            {self.first.pk, self.second.pk},
        )
        self.assertTrue(can_view_event_results(self.event, self.first))

        self.event.participant_view_permission = "realtime"
        self.event.save(update_fields=["participant_view_permission"])
        self.assertEqual(
            self.ids(visible_participants_for_user(self.event, self.unsubmitted)),
            {self.first.pk, self.second.pk, self.unsubmitted.pk},
        )
        self.assertTrue(can_view_event_results(self.event, self.unsubmitted))

        for member in (self.hidden_member, self.excluded_member):
            with self.subTest(member=member.email):
                self.assertEqual(
                    self.ids(visible_participants_for_user(self.event, member)),
                    {member.pk},
                )
                self.assertFalse(can_view_event_results(self.event, member))


class AggregationPermissionApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("organizer-api-results@example.com", "Org", "Owner")
        self.first = create_member("first-api-results@example.com", "First", "Person")
        self.second = create_member("second-api-results@example.com", "Second", "Person")
        self.unsubmitted = create_member("draft-api-results@example.com", "Draft", "Person")
        self.unrelated = create_member("unrelated-api-results@example.com", "Other", "Person")
        self.event = Event.objects.create(
            code="APIRESULT",
            name="API Results",
            organizer=self.organizer,
            mode="inperson",
            start_minutes=9 * 60,
            end_minutes=10 * 60 + 45,
            slot_minutes=15,
            days=[1],
            participant_view_permission="own_only",
        )
        self.first_participant = Participant.objects.create(
            event=self.event,
            member=self.first,
            participant_name="First Person",
            availability_inperson=[1] * 7,
            availability_virtual=[0] * 7,
            submitted=True,
        )
        self.second_participant = Participant.objects.create(
            event=self.event,
            member=self.second,
            participant_name="Second Person",
            availability_inperson=[0] * 7,
            availability_virtual=[0] * 7,
            submitted=True,
        )
        self.draft_participant = Participant.objects.create(
            event=self.event,
            member=self.unsubmitted,
            participant_name="Draft Person",
            availability_inperson=[0] * 7,
            availability_virtual=[0] * 7,
            submitted=False,
        )

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def test_direct_api_access_and_result_visibility_matrix(self):
        self.assertEqual(self.client.get("/api/events/results").status_code, 401)

        self.authenticate(self.unrelated)
        unrelated_participants = self.client.get(f"/api/events/participants?code={self.event.code}")
        self.assertEqual(unrelated_participants.status_code, 403)
        self.assertEqual(
            self.client.get(f"/api/events/results?code={self.event.code}").status_code,
            403,
        )

        self.authenticate(self.first)
        own_only = self.client.get(f"/api/events/participants?code={self.event.code}")
        self.assertEqual(own_only.status_code, 200)
        self.assertEqual(
            [participant["id"] for participant in own_only.data["participants"]],
            [str(self.first.pk)],
        )
        self.assertIn("private", own_only["Cache-Control"])
        self.assertIn("no-store", own_only["Cache-Control"])
        self.assertIn("Authorization", own_only["Vary"])
        self.assertEqual(
            self.client.get(f"/api/events/results?code={self.event.code}").status_code,
            403,
        )

        self.authenticate(self.organizer)
        organizer_list = self.client.get(f"/api/events/participants?code={self.event.code}")
        self.assertEqual(len(organizer_list.data["participants"]), 3)
        organizer_results = self.client.get(f"/api/events/results?code={self.event.code}")
        self.assertEqual(organizer_results.status_code, 200)
        self.assertEqual(organizer_results.data["results"]["countedResponseTotal"], 2)
        self.assertEqual(organizer_results.data["results"]["unansweredParticipantTotal"], 1)
        self.assertEqual(
            organizer_results.data["results"]["channels"]["inperson"]["unweighted"],
            [0.5] * 7,
        )
        self.assertIn("private", organizer_results["Cache-Control"])

        self.event.participant_view_permission = "all_after_submit"
        self.event.save(update_fields=["participant_view_permission"])
        self.authenticate(self.unsubmitted)
        before_submit = self.client.get(f"/api/events/participants?code={self.event.code}")
        self.assertEqual(
            [participant["id"] for participant in before_submit.data["participants"]],
            [str(self.unsubmitted.pk)],
        )
        self.assertEqual(
            self.client.get(f"/api/events/results?code={self.event.code}").status_code,
            403,
        )

        self.authenticate(self.first)
        after_submit = self.client.get(f"/api/events/participants?code={self.event.code}")
        self.assertEqual(
            {participant["id"] for participant in after_submit.data["participants"]},
            {str(self.first.pk), str(self.second.pk)},
        )
        self.assertEqual(
            self.client.get(f"/api/events/results?code={self.event.code}").status_code,
            200,
        )

        self.event.participant_view_permission = "realtime"
        self.event.save(update_fields=["participant_view_permission"])
        self.authenticate(self.unsubmitted)
        realtime = self.client.get(f"/api/events/participants?code={self.event.code}")
        self.assertEqual(
            {participant["id"] for participant in realtime.data["participants"]},
            {str(self.first.pk), str(self.second.pk), str(self.unsubmitted.pk)},
        )
        self.assertEqual(
            self.client.get(f"/api/events/results?code={self.event.code}").status_code,
            200,
        )

        Weight.objects.create(
            event=self.event,
            participant=self.draft_participant,
            included=False,
        )
        self.assertEqual(
            self.client.get(f"/api/events/results?code={self.event.code}").status_code,
            403,
        )

        self.authenticate(self.organizer)
        self.assertEqual(self.client.get("/api/events/results").status_code, 400)
        self.assertEqual(self.client.get("/api/events/results?code=NOPE").status_code, 404)

    def test_canonical_permission_and_required_weight_api(self):
        self.authenticate(self.organizer)
        created = self.client.post(
            "/api/events",
            {
                "name": "Legacy client",
                "participantViewPermission": "all",
            },
            format="json",
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(
            created.data["event"]["participantViewPermission"],
            "all_after_submit",
        )

        updated = self.client.put(
            f"/api/events/weights?code={self.event.code}",
            {
                "weights": [
                    {
                        "participantId": str(self.first.pk),
                        "weight": 0.75,
                        "included": 1,
                        "required": 1,
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.data["weights"][0]["required"], 1)

        preserved = self.client.put(
            f"/api/events/weights?code={self.event.code}",
            {"weights": [{"participantId": str(self.first.pk)}]},
            format="json",
        )
        self.assertEqual(preserved.status_code, 200)
        self.assertEqual(preserved.data["weights"][0]["weight"], 0.75)
        self.assertEqual(preserved.data["weights"][0]["required"], 1)

        for entry in [
            "invalid",
            {"participantId": str(self.first.pk), "required": 2},
        ]:
            with self.subTest(entry=entry):
                response = self.client.put(
                    f"/api/events/weights?code={self.event.code}",
                    {"weights": [entry]},
                    format="json",
                )
                self.assertEqual(response.status_code, 400)
