from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.test import SimpleTestCase

from apps.scheduling.services.finalization import FinalizationError, normalize_final_time
from apps.scheduling.services.finalization.slot_matching import (
    _matching_absolute_slot_indices,
    _weekly_slot_indices,
)
from apps.scheduling.services.slots import (
    EventSlotGroup,
    SlotConfigurationError,
    api_slot_groups,
    build_event_slot_groups,
    event_slot_count,
    event_window_duration_minutes,
    parse_time_value,
    validate_minute_configuration,
)


def event(**changes):
    values = {
        "start_minutes": 9 * 60,
        "end_minutes": 10 * 60,
        "slot_minutes": 30,
        "spans_next_day": False,
        "days": [1],
        "day_selection_type": "days_of_week",
        "specific_dates": None,
        "timezone": "UTC",
        "mode": "inperson",
        "location": "",
    }
    values.update(changes)
    return SimpleNamespace(**values)


class SlotDomainEdgeTests(SimpleTestCase):
    def test_fast_slot_count_matches_materialized_weekly_date_and_dst_geometry(self):
        candidates = [
            event(days=[3, 1, 3]),
            event(
                start_minutes=23 * 60,
                end_minutes=60,
                spans_next_day=True,
                days=[0, 6],
            ),
            event(
                day_selection_type="specific_dates",
                specific_dates=["2026-07-20", "2026-07-21"],
            ),
            event(
                start_minutes=60,
                end_minutes=4 * 60,
                timezone="America/Los_Angeles",
                day_selection_type="specific_dates",
                specific_dates=["2026-03-08"],
            ),
            event(
                start_minutes=0,
                end_minutes=3 * 60,
                timezone="America/Los_Angeles",
                day_selection_type="specific_dates",
                specific_dates=["2026-11-01"],
            ),
            event(
                start_minutes=23 * 60,
                end_minutes=60,
                spans_next_day=True,
                timezone="America/Los_Angeles",
                day_selection_type="specific_dates",
                specific_dates=["2026-07-20"],
            ),
        ]

        for candidate in candidates:
            with self.subTest(candidate=candidate):
                materialized = sum(len(group.slots) for group in build_event_slot_groups(candidate))
                self.assertEqual(event_slot_count(candidate), materialized)

        spring_forward = candidates[3]
        fall_back = candidates[4]
        self.assertEqual(event_slot_count(spring_forward), 4)
        self.assertEqual(event_slot_count(fall_back), 8)
        self.assertEqual(api_slot_groups(event())[0]["key"], "weekday:1")

    def test_fast_slot_count_does_not_materialize_slot_groups_and_enforces_cap(self):
        weekly = event(days=[1, 2])
        dated = event(
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
        )
        with patch(
            "apps.scheduling.services.slots.build_event_slot_groups",
            side_effect=AssertionError("slot geometry should not be built"),
        ):
            self.assertEqual(event_slot_count(weekly), 4)
            self.assertEqual(event_slot_count(dated), 2)

        exactly_one_thousand = event(
            start_minutes=0,
            end_minutes=12 * 60 + 30,
            slot_minutes=15,
            day_selection_type="specific_dates",
            specific_dates=[f"2026-07-{day:02d}" for day in range(1, 21)],
        )
        self.assertEqual(event_slot_count(exactly_one_thousand), 1000)

        over_limit = event(
            start_minutes=0,
            end_minutes=12 * 60 + 30,
            slot_minutes=15,
            day_selection_type="specific_dates",
            specific_dates=[f"2026-07-{day:02d}" for day in range(1, 22)],
        )
        with self.assertRaisesMessage(SlotConfigurationError, "at most 1000"):
            event_slot_count(over_limit)

    def test_fast_slot_count_rejects_invalid_group_configuration(self):
        candidates = [
            (event(days=[]), "valid days"),
            (event(days=[True]), "valid days"),
            (
                event(day_selection_type="specific_dates", specific_dates=None),
                "at least one date",
            ),
            (
                event(day_selection_type="specific_dates", specific_dates=("2026-07-20",)),
                "at least one date",
            ),
            (
                event(day_selection_type="specific_dates", specific_dates=["not-a-date"]),
                "valid ISO dates",
            ),
            (event(day_selection_type="other"), "Invalid daySelectionType"),
            (
                event(
                    start_minutes=2 * 60,
                    end_minutes=4 * 60,
                    timezone="America/Los_Angeles",
                    day_selection_type="specific_dates",
                    specific_dates=["2026-03-08"],
                ),
                "nonexistent local time",
            ),
        ]

        for candidate, message in candidates:
            with (
                self.subTest(message=message),
                self.assertRaisesMessage(SlotConfigurationError, message),
            ):
                event_slot_count(candidate)

    def test_fast_slot_count_defensive_elapsed_time_checks(self):
        candidate = event(
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
        )
        with (
            patch(
                "apps.scheduling.services.slots._resolve_boundary",
                side_effect=[
                    datetime(2026, 7, 20, 10, tzinfo=UTC),
                    datetime(2026, 7, 20, 9, tzinfo=UTC),
                ],
            ),
            self.assertRaisesMessage(SlotConfigurationError, "real elapsed time"),
        ):
            event_slot_count(candidate)

        with (
            patch(
                "apps.scheduling.services.slots._resolve_boundary",
                side_effect=[
                    datetime(2026, 7, 20, 10, tzinfo=UTC),
                    datetime(2026, 7, 20, 10, 20, tzinfo=UTC),
                ],
            ),
            self.assertRaisesMessage(SlotConfigurationError, "cannot be divided"),
        ):
            event_slot_count(candidate)

    def test_time_parsing_and_minute_configuration_errors(self):
        self.assertEqual(parse_time_value("09:15", "startTime"), 9 * 60 + 15)
        for value, message in [
            ("9", "HH:MM"),
            ("24:00", "valid time"),
        ]:
            with (
                self.subTest(value=value),
                self.assertRaisesMessage(SlotConfigurationError, message),
            ):
                parse_time_value(value, "startTime")

        for candidate, message in [
            (event(start_minutes=-1), "startTime"),
            (event(end_minutes=24 * 60), "endTime"),
            (
                event(start_minutes=9 * 60, end_minutes=10 * 60, spans_next_day=True),
                "overnight event",
            ),
            (
                event(start_minutes=9 * 60, end_minutes=9 * 60),
                "must be different",
            ),
        ]:
            with (
                self.subTest(message=message),
                self.assertRaisesMessage(SlotConfigurationError, message),
            ):
                validate_minute_configuration(candidate)

        with self.assertRaisesMessage(SlotConfigurationError, "direction is invalid"):
            event_window_duration_minutes(event(start_minutes=9 * 60, end_minutes=9 * 60))

    def test_invalid_day_and_date_configurations(self):
        for candidate, message in [
            (event(days=[]), "valid days"),
            (event(days=[7]), "valid days"),
            (
                event(day_selection_type="specific_dates", specific_dates=[]),
                "at least one date",
            ),
            (
                event(
                    day_selection_type="specific_dates",
                    specific_dates=["not-a-date"],
                ),
                "valid ISO dates",
            ),
            (
                event(
                    start_minutes=0,
                    end_minutes=23 * 60 + 45,
                    slot_minutes=15,
                    day_selection_type="specific_dates",
                    specific_dates=[f"2026-07-{day:02d}" for day in range(1, 12)],
                ),
                "at most 1000 availability slots",
            ),
            (event(day_selection_type="other"), "Invalid daySelectionType"),
        ]:
            with (
                self.subTest(message=message),
                self.assertRaisesMessage(SlotConfigurationError, message),
            ):
                build_event_slot_groups(candidate)

    def test_specific_date_overnight_and_nonexistent_boundaries(self):
        overnight = event(
            start_minutes=23 * 60,
            end_minutes=60,
            spans_next_day=True,
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
        )
        slots = build_event_slot_groups(overnight)[0].slots
        self.assertEqual(len(slots), 4)
        self.assertEqual(slots[-1].end_day_offset, 1)

        nonexistent = event(
            start_minutes=2 * 60,
            end_minutes=4 * 60,
            timezone="America/Los_Angeles",
            day_selection_type="specific_dates",
            specific_dates=["2026-03-08"],
        )
        with self.assertRaisesMessage(SlotConfigurationError, "nonexistent local time"):
            build_event_slot_groups(nonexistent)

    def test_defensive_elapsed_time_checks(self):
        candidate = event(
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
        )
        with (
            patch(
                "apps.scheduling.services.slots._resolve_boundary",
                side_effect=[
                    datetime(2026, 7, 20, 10, tzinfo=UTC),
                    datetime(2026, 7, 20, 9, tzinfo=UTC),
                ],
            ),
            self.assertRaisesMessage(SlotConfigurationError, "real elapsed time"),
        ):
            build_event_slot_groups(candidate)

        with (
            patch(
                "apps.scheduling.services.slots._resolve_boundary",
                side_effect=[
                    datetime(2026, 7, 20, 10, tzinfo=UTC),
                    datetime(2026, 7, 20, 10, 20, tzinfo=UTC),
                ],
            ),
            self.assertRaisesMessage(SlotConfigurationError, "cannot be divided"),
        ):
            build_event_slot_groups(candidate)

    def test_finalization_defensive_slot_matching(self):
        malformed = event(
            day_selection_type="specific_dates",
            specific_dates=None,
        )
        with self.assertRaisesMessage(FinalizationError, "at least one date"):
            normalize_final_time(
                malformed,
                starts_at=datetime(2026, 7, 20, 9, tzinfo=UTC),
                ends_at=datetime(2026, 7, 20, 10, tzinfo=UTC),
                channel="inperson",
                location="",
            )

        empty_group = EventSlotGroup(key="empty", label="Empty", slots=())
        with (
            patch(
                "apps.scheduling.services.finalization.slot_matching.build_event_slot_groups",
                return_value=(empty_group,),
            ),
            self.assertRaisesMessage(FinalizationError, "configured event date"),
        ):
            _matching_absolute_slot_indices(
                event(slot_minutes=30),
                datetime(2026, 7, 20, 9, tzinfo=UTC),
                datetime(2026, 7, 20, 10, tzinfo=UTC),
            )

        weekly = event(start_minutes=9 * 60, end_minutes=11 * 60)
        with self.assertRaisesMessage(FinalizationError, "align to 30-minute"):
            _weekly_slot_indices(
                weekly,
                datetime(2026, 7, 20, 9, 15, tzinfo=UTC),
                datetime(2026, 7, 20, 9, 45, tzinfo=UTC),
                ZoneInfo("UTC"),
            )

        with (
            patch(
                "apps.scheduling.services.finalization.slot_matching.valid_localizations",
                return_value=(datetime(2026, 7, 20, 8, tzinfo=UTC),),
            ),
            self.assertRaisesMessage(FinalizationError, "align to 30-minute"),
        ):
            _weekly_slot_indices(
                weekly,
                datetime(2026, 7, 20, 9, tzinfo=UTC),
                datetime(2026, 7, 20, 10, tzinfo=UTC),
                ZoneInfo("UTC"),
            )

    def test_finalization_requires_the_configured_meeting_duration(self):
        candidate = event(
            day_selection_type="specific_dates",
            specific_dates=["2026-07-20"],
            meeting_duration_minutes=30,
        )
        with self.assertRaisesMessage(FinalizationError, "exactly 30 minutes"):
            normalize_final_time(
                candidate,
                starts_at=datetime(2026, 7, 20, 9, tzinfo=UTC),
                ends_at=datetime(2026, 7, 20, 10, tzinfo=UTC),
                channel="inperson",
                location="",
            )

        normalized = normalize_final_time(
            candidate,
            starts_at=datetime(2026, 7, 20, 9, tzinfo=UTC),
            ends_at=datetime(2026, 7, 20, 9, 30, tzinfo=UTC),
            channel="inperson",
            location="",
        )
        self.assertEqual(normalized["slot_indices"], [0])
