from datetime import UTC, datetime
from unittest.mock import patch

from django.test import TestCase

from apps.authn.tests.helpers import create_member
from apps.scheduling.aggregation import build_event_results
from apps.scheduling.models import Event, Participant


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
