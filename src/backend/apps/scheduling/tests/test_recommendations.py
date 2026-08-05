from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch

from django.test import TestCase

from apps.authn.tests.helpers import create_member
from apps.scheduling.aggregation import build_event_results
from apps.scheduling.models import Event, Participant
from apps.scheduling.recommendations import build_ranked_recommendations


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
            "apps.scheduling.recommendations.valid_localizations",
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
