from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch

from django.test import TestCase

from apps.authn.tests.helpers import create_member
from apps.scheduling.models import Event, Participant, Weight
from apps.scheduling.services.results.aggregation import build_event_results
from apps.scheduling.services.results.recommendations import (
    MAX_RECOMMENDATIONS,
    RECOMMENDATION_RULE_VERSION,
    build_ranked_recommendations,
)

BEFORE_THE_DATES = datetime(2026, 7, 19, 12, tzinfo=UTC)


class RecommendationDomainTests(TestCase):
    def setUp(self):
        self.organizer = create_member("recommendation-organizer@example.com")

    def event(self, code, **overrides):
        values = {
            "name": code,
            "organizer": self.organizer,
            "mode": "inperson",
            "start_minutes": 9 * 60,
            "end_minutes": 9 * 60 + 30,
            "slot_minutes": 15,
            "days": [1],
            "timezone": "UTC",
        }
        values.update(overrides)
        values.setdefault("meeting_duration_minutes", values["slot_minutes"])
        return Event.objects.create(code=code, **values)

    def submit(self, event, values):
        member = create_member(f"{event.code.lower()}@example.com")
        slot_count = len(values)
        return Participant.objects.create(
            event=event,
            member=member,
            participant_name=member.display_name(),
            availability_inperson=list(values),
            availability_virtual=[0] * slot_count,
            submitted=True,
        )

    def respond(self, event, name, *, inperson, virtual=None, weight=None):
        """Submit one person's availability, optionally with an organizer weight."""

        member = create_member(f"{event.code.lower()}-{name.lower()}@example.com")
        participant = Participant.objects.create(
            event=event,
            member=member,
            participant_name=name,
            availability_inperson=list(inperson),
            availability_virtual=list(virtual if virtual is not None else [0] * len(inperson)),
            submitted=True,
        )
        if weight is not None:
            Weight.objects.create(event=event, participant=participant, weight=weight)
        return participant

    def dated_event(self, code, dates, **overrides):
        """Half-hour slots from 09:00 to 13:00 and an hour-long meeting per date."""

        values = {
            "end_minutes": 13 * 60,
            "slot_minutes": 30,
            "meeting_duration_minutes": 60,
            "day_selection_type": "specific_dates",
            "specific_dates": list(dates),
        }
        values.update(overrides)
        return self.event(code, **values)

    @staticmethod
    def marks(slot_total, indices, value=1):
        return [value if index in indices else 0 for index in range(slot_total)]

    def test_windows_nobody_can_attend_never_pad_the_list(self):
        # The reported event: four real options, then only 0% windows, which
        # the old fixed top ten appended (overlapping #1 and each other).
        event = self.dated_event(
            "PADDING",
            ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"],
        )
        monday_10, tuesday_11, wednesday_12, thursday_9 = {2, 3}, {12, 13}, {22, 23}, {24, 25}
        for name, windows in (
            ("Ada", monday_10 | tuesday_11 | wednesday_12 | thursday_9),
            ("Ben", monday_10 | tuesday_11 | wednesday_12),
            ("Cara", monday_10 | tuesday_11),
            ("Dev", monday_10 | thursday_9),
        ):
            self.respond(event, name, inperson=self.marks(32, windows))

        results = build_event_results(event, now=BEFORE_THE_DATES)

        self.assertEqual(
            [
                (
                    recommendation["rank"],
                    recommendation["label"],
                    recommendation["weightedAvailability"],
                )
                for recommendation in results["recommendations"]
            ],
            [
                (1, "2026-07-20 10:00–11:00", 1.0),
                (2, "2026-07-21 11:00–12:00", 0.75),
                (3, "2026-07-22 12:00–13:00", 0.5),
                (4, "2026-07-23 09:00–10:00", 0.5),
            ],
        )
        basis = results["recommendationBasis"]
        self.assertEqual(basis["status"], "ready")
        self.assertEqual(basis["ruleVersion"], RECOMMENDATION_RULE_VERSION)
        self.assertEqual(basis["maximumRecommendations"], MAX_RECOMMENDATIONS)
        self.assertEqual(basis["candidateTotal"], 28)
        self.assertEqual(basis["viableWindowTotal"], 4)
        self.assertEqual(basis["qualifyingWindowTotal"], 4)
        self.assertEqual(basis["bestWeightedAvailability"], 1.0)
        self.assertEqual(basis["weightedAvailabilityFloor"], 0.5)
        self.assertIsNone(basis["nextWeightedAvailability"])
        self.assertEqual(basis["listEnd"], "noMoreWindows")
        self.assertFalse(basis["zeroWeightOnlyAvailability"])

    def test_a_long_free_stretch_tiles_into_separate_windows_above_half_the_best(self):
        event = self.dated_event("STRETCH", ["2026-07-20", "2026-07-21"])
        for name in ("Ada", "Ben", "Cara"):
            self.respond(event, name, inperson=self.marks(16, set(range(8))))
        # Dev is free all Monday morning and on Tuesday 09:00–10:00, alone.
        self.respond(event, "Dev", inperson=self.marks(16, set(range(8)) | {8, 9}))

        results = build_event_results(event, now=BEFORE_THE_DATES)

        # Seven 100% starts fit Monday; the ones shifted by half an hour share
        # a slot with a listed hour, so the list tiles the morning instead.
        self.assertEqual(
            [recommendation["slotIndices"] for recommendation in results["recommendations"]],
            [[0, 1], [2, 3], [4, 5], [6, 7]],
        )
        basis = results["recommendationBasis"]
        self.assertEqual(basis["viableWindowTotal"], 8)
        self.assertEqual(basis["qualifyingWindowTotal"], 4)
        # Tuesday suits one person in four, under half of the best.
        self.assertEqual(basis["nextWeightedAvailability"], 0.25)
        self.assertEqual(basis["listEnd"], "belowFloor")

    def test_a_weaker_shift_of_a_listed_window_is_not_reported_as_the_next_option(self):
        event = self.dated_event("SHIFTED", ["2026-07-20"], end_minutes=10 * 60 + 30)
        self.respond(event, "Ada", inperson=[1, 1, 0.5])
        self.respond(event, "Ben", inperson=[1, 1, 0])

        results = build_event_results(event, now=BEFORE_THE_DATES)

        self.assertEqual(
            [recommendation["slotIndices"] for recommendation in results["recommendations"]],
            [[0, 1]],
        )
        basis = results["recommendationBasis"]
        self.assertIsNone(basis["nextWeightedAvailability"])
        self.assertEqual(basis["listEnd"], "noMoreWindows")

    def test_exactly_half_of_the_best_is_kept_despite_float_rounding(self):
        event = self.event(
            "HALF", day_selection_type="specific_dates", specific_dates=["2026-07-20"]
        )
        self.respond(event, "Ada", inperson=[1, 0], weight=0.1)
        self.respond(event, "Ben", inperson=[1, 0], weight=0.2)
        self.respond(event, "Cara", inperson=[1, 1], weight=0.3)

        results = build_event_results(event, now=BEFORE_THE_DATES)

        # 0.3 / (0.1 + 0.2 + 0.3) is 0.49999999999999994 in floating point.
        self.assertEqual(
            [
                (recommendation["slotIndices"], recommendation["weightedAvailability"])
                for recommendation in results["recommendations"]
            ],
            [([0], 1.0), ([1], 0.5)],
        )
        self.assertEqual(results["recommendationBasis"]["listEnd"], "noMoreWindows")

    def test_the_list_stops_at_the_ceiling_and_reports_how_many_qualified(self):
        event = self.event(
            "CEILING",
            end_minutes=12 * 60 + 15,
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
        )
        self.respond(event, "Ada", inperson=[1] * 12 + [0.25])

        results = build_event_results(event, now=BEFORE_THE_DATES)

        self.assertEqual(
            [recommendation["rank"] for recommendation in results["recommendations"]],
            list(range(1, MAX_RECOMMENDATIONS + 1)),
        )
        self.assertEqual(
            [recommendation["slotIndex"] for recommendation in results["recommendations"]],
            list(range(MAX_RECOMMENDATIONS)),
        )
        basis = results["recommendationBasis"]
        self.assertEqual(basis["qualifyingWindowTotal"], 12)
        self.assertEqual(basis["listEnd"], "limit")
        # The next option is #11 (100%), not the 25% slot under the floor.
        self.assertIsNone(basis["nextWeightedAvailability"])

    def test_exact_ties_fall_to_the_earlier_time_whatever_the_float_noise(self):
        event = self.dated_event("FLOATTIE", ["2026-07-20"], end_minutes=11 * 60)
        # 0.1 + 0.2 of the weight is 0.30000000000000004 in floating point,
        # a hair above Ada's 0.3, yet both windows are exactly 50%.
        self.respond(event, "Ada", inperson=[1, 1, 0, 0], weight=0.3)
        self.respond(event, "Zoe", inperson=[1, 1, 0, 0], weight=0)
        self.respond(event, "Quinn", inperson=[0, 1, 1, 0], weight=0.1)
        self.respond(event, "Quincy", inperson=[0, 1, 1, 0], weight=0.2)

        results = build_event_results(event, now=BEFORE_THE_DATES)

        self.assertEqual(
            [
                (recommendation["label"], recommendation["weightedAvailability"])
                for recommendation in results["recommendations"]
            ],
            [("2026-07-20 09:00–10:00", 0.5)],
        )

    def test_the_same_time_is_listed_once_per_channel_in_mixed_mode(self):
        event = self.event(
            "MIXEDSAME",
            mode="mixed",
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
        )
        self.respond(event, "Ada", inperson=[1, 0], virtual=[1, 0.25])

        results = build_event_results(event, now=BEFORE_THE_DATES)

        self.assertEqual(
            [
                (recommendation["channel"], recommendation["slotIndices"])
                for recommendation in results["recommendations"]
            ],
            [("inperson", [0]), ("virtual", [0])],
        )
        # The floor is shared by both channels: virtual at 09:15 (25%) is out.
        self.assertEqual(results["recommendationBasis"]["nextWeightedAvailability"], 0.25)

    def test_weight_zero_availability_alone_never_makes_a_window_viable(self):
        event = self.event(
            "ZEROONLY", day_selection_type="specific_dates", specific_dates=["2026-07-20"]
        )
        self.respond(event, "Ada", inperson=[0, 0], weight=1)
        optional = self.respond(event, "Ben", inperson=[0, 1], weight=0)

        results = build_event_results(event, now=BEFORE_THE_DATES)

        self.assertEqual(results["recommendations"], [])
        basis = results["recommendationBasis"]
        self.assertEqual(basis["status"], "no_viable_windows")
        self.assertTrue(basis["zeroWeightOnlyAvailability"])
        self.assertEqual(basis["candidateTotal"], 2)
        self.assertEqual(basis["viableWindowTotal"], 0)
        self.assertIsNone(basis["listEnd"])
        self.assertEqual(basis["ruleVersion"], RECOMMENDATION_RULE_VERSION)

        optional.availability_inperson = [0, 0]
        optional.save(update_fields=["availability_inperson"])
        nobody = build_event_results(event, now=BEFORE_THE_DATES)["recommendationBasis"]
        self.assertEqual(nobody["status"], "no_viable_windows")
        self.assertFalse(nobody["zeroWeightOnlyAvailability"])

        Participant.objects.filter(event=event, participant_name="Ada").delete()
        weightless = build_event_results(event, now=BEFORE_THE_DATES)
        self.assertEqual(weightless["recommendations"], [])
        self.assertEqual(weightless["recommendationBasis"]["status"], "no_weighted_responses")

    def test_weekly_recommendations_choose_the_next_occurrence_after_a_passed_slot(self):
        event = self.event("WEEKLY")
        self.submit(event, [1, 0.5])

        results = build_event_results(
            event,
            now=datetime(2026, 7, 20, 10),
        )

        self.assertEqual(results["recommendations"][0]["label"], "Mon 09:00–09:15")
        self.assertEqual(
            results["recommendations"][0]["suggestedStartsAt"],
            "2026-07-27T09:00:00+00:00",
        )
        self.assertEqual(results["recommendations"][0]["fullyAvailableParticipantTotal"], 1)
        self.assertEqual(results["recommendations"][1]["partiallyAvailableParticipantTotal"], 1)

    def test_overnight_labels_explain_day_offsets(self):
        event = self.event(
            "OVERNIGHT",
            start_minutes=23 * 60 + 45,
            end_minutes=15,
            spans_next_day=True,
        )
        self.submit(event, [1, 0.5])

        results = build_event_results(
            event,
            now=datetime(2026, 7, 19, 12, tzinfo=UTC),
        )

        self.assertEqual(results["recommendations"][0]["label"], "Mon 23:45–00:00 +1d")
        self.assertEqual(results["recommendations"][1]["label"], "Mon 00:00 +1d–00:15 +1d")

    def test_ambiguous_weekly_occurrence_is_skipped_for_a_selectable_future_time(self):
        event = self.event(
            "DSTFALL",
            start_minutes=90,
            end_minutes=120,
            slot_minutes=30,
            days=[0],
            timezone="America/New_York",
        )
        self.submit(event, [1])

        results = build_event_results(
            event,
            now=datetime(2026, 10, 31, 12, tzinfo=UTC),
        )

        self.assertEqual(
            results["recommendations"][0]["suggestedStartsAt"],
            "2026-11-08T06:30:00+00:00",
        )

    def test_no_valid_future_occurrence_or_specific_date_returns_no_recommendations(self):
        weekly = self.event("NOVALID")
        self.submit(weekly, [1, 1])
        with patch(
            "apps.scheduling.services.results.recommendations.valid_localizations",
            return_value=(),
        ):
            weekly_results = build_event_results(
                weekly,
                now=datetime(2026, 7, 19, 12, tzinfo=UTC),
            )
        self.assertEqual(weekly_results["recommendations"], [])
        self.assertEqual(weekly_results["recommendationBasis"]["status"], "no_future_slots")

        past = self.event(
            "PASTDATES",
            day_selection_type="specific_dates",
            specific_dates=["2020-01-06"],
        )
        self.submit(past, [1, 1])
        past_results = build_event_results(
            past,
            now=datetime(2026, 7, 19, 12, tzinfo=UTC),
        )
        self.assertEqual(past_results["recommendations"], [])
        self.assertEqual(past_results["recommendationBasis"]["status"], "no_future_slots")

    def test_contiguous_windows_use_each_participants_minimum_and_do_not_cross_groups(self):
        event = self.event(
            "WINDOWS",
            end_minutes=10 * 60,
            meeting_duration_minutes=30,
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20", "2026-07-21"],
        )
        first = self.submit(event, [1, 0.5, 1, 1, 1, 0, 1, 1])
        second = create_member("windows-second@example.com")
        Participant.objects.create(
            event=event,
            member=second,
            participant_name=second.display_name(),
            availability_inperson=[1, 1, 0, 1, 1, 1, 1, 1],
            availability_virtual=[0] * 8,
            submitted=True,
        )

        results = build_event_results(
            event,
            now=datetime(2026, 7, 19, 12, tzinfo=UTC),
        )

        first_candidate = results["recommendations"][0]
        self.assertEqual(first_candidate["slotIndices"], [6, 7])
        self.assertEqual(first_candidate["durationMinutes"], 30)
        self.assertEqual(first_candidate["weightedAvailability"], 1.0)
        self.assertEqual(first_candidate["fullyAvailableParticipantTotal"], 2)
        first_date_window = next(
            recommendation
            for recommendation in results["recommendations"]
            if recommendation["slotIndices"] == [0, 1]
        )
        self.assertEqual(first_date_window["weightedAvailability"], 0.75)
        self.assertEqual(first_date_window["partiallyAvailableParticipantTotal"], 1)
        self.assertTrue(
            all(
                recommendation["slotIndices"] in ([0, 1], [1, 2], [2, 3], [4, 5], [5, 6], [6, 7])
                for recommendation in results["recommendations"]
            )
        )
        self.assertEqual(
            results["recommendationBasis"]["participantWindowScore"],
            "minimumAvailability",
        )
        self.assertEqual(results["recommendationBasis"]["candidateSlotTotal"], 2)
        self.assertEqual(first.event_id, event.pk)

    def test_windows_never_span_a_blocked_slot_and_still_rank_the_open_runs(self):
        event = self.event(
            "BLOCKRUNS",
            end_minutes=10 * 60 + 30,
            meeting_duration_minutes=30,
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20", "2026-07-21"],
            # Day one keeps rows 1-2 and row 5 open; day two loses only its last row.
            blocked_slots={"date:2026-07-20": [0, 3, 4], "date:2026-07-21": [5]},
        )
        self.submit(event, [1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1, 0.5, 1])

        results = build_event_results(
            event,
            now=datetime(2026, 7, 19, 12, tzinfo=UTC),
        )

        windows = [recommendation["slotIndices"] for recommendation in results["recommendations"]]
        # Row 5 on day one is open but too short for a two-slot window on its own.
        # Day two's 100% run tiles into [6, 7] and [8, 9]; the shifted [7, 8]
        # and [9, 10] share a slot with them, so they are not listed again.
        self.assertEqual(windows, [[6, 7], [8, 9], [1, 2]])
        self.assertTrue(all(index not in {0, 3, 4, 11} for window in windows for index in window))
        self.assertEqual(
            [
                recommendation["weightedAvailability"]
                for recommendation in results["recommendations"]
            ],
            [1.0, 1.0, 0.5],
        )
        self.assertEqual(results["blockedSlotIndices"], [0, 3, 4, 11])
        self.assertEqual(
            results["channels"]["inperson"]["unweighted"][:6], [0.0, 1.0, 0.5, 0.0, 0.0, 1.0]
        )

        fully_blocked = self.event(
            "ALLBLOCKED",
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
            blocked_slots={"date:2026-07-20": [0, 1]},
        )
        self.submit(fully_blocked, [1, 1])
        blocked_results = build_event_results(
            fully_blocked,
            now=datetime(2026, 7, 19, 12, tzinfo=UTC),
        )
        self.assertEqual(blocked_results["recommendations"], [])
        self.assertEqual(blocked_results["recommendationBasis"]["status"], "no_future_slots")

    def test_invalid_or_too_long_duration_has_no_candidates(self):
        invalid_event = SimpleNamespace(slot_minutes=30, meeting_duration_minutes=45)
        recommendations, basis = build_ranked_recommendations(
            invalid_event,
            classified={
                "counted": [
                    {
                        "availability": {"inperson": [1.0]},
                        "weight": 1.0,
                    }
                ],
                "unanswered": [],
                "excluded": [],
            },
            channel_results={"inperson": {"weighted": [1.0], "unweighted": [1.0]}},
        )
        self.assertEqual(recommendations, [])
        self.assertEqual(basis["status"], "invalid_duration")
        self.assertEqual(basis["ruleVersion"], RECOMMENDATION_RULE_VERSION)

        too_long = self.event(
            "TOOLONG",
            meeting_duration_minutes=60,
        )
        self.submit(too_long, [1, 1])
        results = build_event_results(
            too_long,
            now=datetime(2026, 7, 19, 12, tzinfo=UTC),
        )
        self.assertEqual(results["recommendations"], [])
        self.assertEqual(results["recommendationBasis"]["status"], "no_future_slots")
