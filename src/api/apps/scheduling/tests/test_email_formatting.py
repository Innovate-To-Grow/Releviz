"""Readable times, zones, and meeting methods in event emails."""

import re
import uuid
from datetime import UTC, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import translation

from apps.authn.tests.helpers import create_member
from apps.scheduling.models import Event, EventInvitation, FinalMeeting
from apps.scheduling.services.email_formatting import (
    format_email_datetime,
    format_email_time_range,
    local_datetime,
    meeting_method_label,
    nowrap_times,
    zone_label,
    zone_suffix,
)
from apps.scheduling.services.finalization import (
    final_confirmation_body,
    final_confirmation_html_body,
)
from apps.scheduling.services.ics import final_meeting_ics
from apps.scheduling.services.invitations import invitation_body, invitation_html_body

DEADLINE = datetime(2026, 10, 9, 17, 0, tzinfo=UTC)
NEW_YORK = ZoneInfo("America/New_York")
NBSP = "\u00a0"


class EmailDatetimeTests(SimpleTestCase):
    def test_utc(self):
        self.assertEqual(
            format_email_datetime(DEADLINE, "UTC"), "Friday, October 9, 2026 at 5:00 PM UTC"
        )

    def test_daylight_saving_zone_in_summer_and_winter(self):
        self.assertEqual(
            format_email_datetime(DEADLINE, "America/New_York"),
            "Friday, October 9, 2026 at 1:00 PM EDT",
        )
        self.assertEqual(
            format_email_datetime(datetime(2026, 1, 15, 17, 0, tzinfo=UTC), "America/New_York"),
            "Thursday, January 15, 2026 at 12:00 PM EST",
        )

    def test_zones_without_a_letter_abbreviation_show_their_offset(self):
        moment = datetime(2026, 7, 1, 8, 0, tzinfo=UTC)
        for tz_name, expected in (
            ("Asia/Dubai", "Wednesday, July 1, 2026 at 12:00 PM UTC+04:00"),
            ("America/Sao_Paulo", "Wednesday, July 1, 2026 at 5:00 AM UTC-03:00"),
            ("Asia/Kathmandu", "Wednesday, July 1, 2026 at 1:45 PM UTC+05:45"),
            ("Asia/Kolkata", "Wednesday, July 1, 2026 at 1:30 PM IST"),
        ):
            with self.subTest(tz_name=tz_name):
                self.assertEqual(format_email_datetime(moment, tz_name), expected)

    def test_twelve_hour_clock(self):
        for hour, minute, expected in (
            (0, 0, "Monday, March 2, 2026 at 12:00 AM UTC"),
            (12, 0, "Monday, March 2, 2026 at 12:00 PM UTC"),
            (9, 5, "Monday, March 2, 2026 at 9:05 AM UTC"),
            (23, 59, "Monday, March 2, 2026 at 11:59 PM UTC"),
        ):
            with self.subTest(hour=hour, minute=minute):
                moment = datetime(2026, 3, 2, hour, minute, tzinfo=UTC)
                self.assertEqual(format_email_datetime(moment, "UTC"), expected)

    def test_naive_values_are_utc_and_aware_values_are_converted(self):
        self.assertEqual(
            format_email_datetime(datetime(2026, 3, 2, 9, 5), "America/New_York"),
            "Monday, March 2, 2026 at 4:05 AM EST",
        )
        self.assertEqual(
            format_email_datetime(datetime(2026, 3, 2, 9, 5, tzinfo=ZoneInfo("Asia/Tokyo")), "UTC"),
            "Monday, March 2, 2026 at 12:05 AM UTC",
        )

    def test_unknown_or_empty_zones_fall_back_to_utc(self):
        for tz_name in ("Mars/Base", "", "/etc/passwd"):
            with self.subTest(tz_name=tz_name):
                self.assertEqual(
                    format_email_datetime(DEADLINE, tz_name),
                    "Friday, October 9, 2026 at 5:00 PM UTC",
                )
                self.assertEqual(local_datetime(DEADLINE, tz_name).utcoffset(), timedelta(0))

    def test_output_does_not_follow_the_active_language(self):
        with override_settings(LANGUAGE_CODE="de"), translation.override("de"):
            self.assertEqual(
                format_email_datetime(DEADLINE, "Europe/Berlin"),
                "Friday, October 9, 2026 at 7:00 PM CEST",
            )
            self.assertEqual(meeting_method_label("inperson"), "In person")


class EmailTimeRangeTests(SimpleTestCase):
    def test_same_day(self):
        self.assertEqual(
            format_email_time_range(
                datetime(2026, 9, 28, 10, tzinfo=UTC), datetime(2026, 9, 28, 11, tzinfo=UTC), "UTC"
            ),
            "Monday, September 28, 2026, 10:00 AM to 11:00 AM UTC",
        )
        self.assertEqual(
            format_email_time_range(
                datetime(2026, 10, 5, 7, tzinfo=UTC),
                datetime(2026, 10, 5, 8, tzinfo=UTC),
                "Europe/Berlin",
            ),
            "Monday, October 5, 2026, 9:00 AM to 10:00 AM CEST",
        )

    def test_crossing_local_midnight_spells_out_both_ends(self):
        self.assertEqual(
            format_email_time_range(
                datetime(2026, 9, 28, 23, tzinfo=UTC),
                datetime(2026, 9, 29, 0, 30, tzinfo=UTC),
                "UTC",
            ),
            "Monday, September 28, 2026 at 11:00 PM UTC to "
            "Tuesday, September 29, 2026 at 12:30 AM UTC",
        )

    def test_dates_are_compared_in_the_local_zone_not_utc(self):
        # 03:00Z to 04:30Z is one UTC date but crosses midnight in New York.
        self.assertEqual(
            format_email_time_range(
                datetime(2026, 9, 29, 3, tzinfo=UTC),
                datetime(2026, 9, 29, 4, 30, tzinfo=UTC),
                "America/New_York",
            ),
            "Monday, September 28, 2026 at 11:00 PM EDT to "
            "Tuesday, September 29, 2026 at 12:30 AM EDT",
        )
        # 23:00Z to 01:00Z crosses UTC midnight but is one evening in New York.
        self.assertEqual(
            format_email_time_range(
                datetime(2026, 9, 28, 23, tzinfo=UTC),
                datetime(2026, 9, 29, 1, tzinfo=UTC),
                "America/New_York",
            ),
            "Monday, September 28, 2026, 7:00 PM to 9:00 PM EDT",
        )

    def test_crossing_a_daylight_saving_switch_spells_out_both_ends(self):
        # 1:30 AM happens twice on November 1: first in EDT, then in EST.
        starts_at = datetime(2026, 11, 1, 1, 30, tzinfo=NEW_YORK)
        ends_at = datetime(2026, 11, 1, 1, 30, fold=1, tzinfo=NEW_YORK)
        self.assertEqual(ends_at.astimezone(UTC) - starts_at.astimezone(UTC), timedelta(hours=1))
        self.assertEqual(
            format_email_time_range(
                starts_at.astimezone(UTC), ends_at.astimezone(UTC), "America/New_York"
            ),
            "Sunday, November 1, 2026 at 1:30 AM EDT to Sunday, November 1, 2026 at 1:30 AM EST",
        )


class ZoneLabelTests(SimpleTestCase):
    def test_letter_abbreviations_are_kept(self):
        self.assertEqual(zone_label(datetime(2026, 1, 1, tzinfo=UTC)), "UTC")
        self.assertEqual(zone_label(DEADLINE.astimezone(NEW_YORK)), "EDT")

    def test_other_names_become_an_offset(self):
        for value, expected in (
            (local_datetime(DEADLINE, "Asia/Kathmandu"), "UTC+05:45"),
            (local_datetime(DEADLINE, "America/Sao_Paulo"), "UTC-03:00"),
            (datetime(2026, 1, 1, tzinfo=timezone(-timedelta(hours=3, minutes=30))), "UTC-03:30"),
            (datetime(2026, 1, 1, tzinfo=timezone(timedelta(hours=1), "MÉZ")), "UTC+01:00"),
            (datetime(2026, 1, 1, tzinfo=timezone(timedelta(0), "+00")), "UTC"),
        ):
            with self.subTest(expected=expected):
                self.assertEqual(zone_label(value), expected)

    def test_zone_suffix_names_the_zone_only_when_the_label_does_not(self):
        self.assertEqual(zone_suffix("UTC", "UTC"), "")
        self.assertEqual(zone_suffix("America/Los_Angeles", "PDT"), " (America/Los_Angeles)")
        self.assertEqual(zone_suffix("Etc/UTC", "UTC"), " (Etc/UTC)")
        # A zone the email could not show is never named next to the UTC fallback.
        self.assertEqual(zone_suffix("Mars/Base", "UTC"), "")
        self.assertEqual(zone_suffix("", "UTC"), "")


class MeetingMethodLabelTests(SimpleTestCase):
    def test_labels_come_from_the_model_choices(self):
        self.assertEqual(meeting_method_label("inperson"), "In person")
        self.assertEqual(meeting_method_label("virtual"), "Virtual")
        self.assertEqual(
            {value: meeting_method_label(value) for value, _ in FinalMeeting.CHANNEL_CHOICES},
            dict(FinalMeeting.CHANNEL_CHOICES),
        )

    def test_unknown_values_are_shown_as_stored(self):
        self.assertEqual(meeting_method_label("hybrid"), "hybrid")
        self.assertEqual(meeting_method_label(""), "")


def detail_rows(html: str) -> list[tuple[str, str]]:
    labels = re.findall(r'class="email-details-label"[^>]*>([^<]*)<', html)
    values = re.findall(r'class="email-details-value"[^>]*>([^<]*)<', html)
    return list(zip(labels, values, strict=True))


def ics_description(content: str) -> str:
    (line,) = [
        line
        for line in content.replace("\r\n ", "").split("\r\n")
        if line.startswith("DESCRIPTION:")
    ]
    return line


@override_settings(FRONTEND_URL="https://app.releviz.test")
class EventEmailTimeTests(TestCase):
    maxDiff = None

    def setUp(self):
        self.organizer = create_member("times-owner@example.com", "Olive", "Owner")
        self.event = Event.objects.create(
            code="TIMES1",
            name="Planning, round 2",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            timezone="America/New_York",
            response_deadline=DEADLINE,
        )
        self.meeting = FinalMeeting(
            starts_at=datetime(2026, 9, 28, 14, 0, tzinfo=UTC),
            ends_at=datetime(2026, 9, 28, 15, 30, tzinfo=UTC),
            timezone="America/New_York",
            channel="virtual",
            location="   ",
            calendar_uid="times@releviz",
            confirmed_at=datetime(2026, 9, 1, 12, 0, tzinfo=UTC),
        )

    def invitation(self):
        return EventInvitation(
            event=self.event, email="ada@example.com", access_token=uuid.UUID(int=1)
        )

    def test_deadline_is_shown_in_the_event_zone_and_named_when_the_label_does_not(self):
        invitation = self.invitation()
        body = invitation_body(invitation)
        self.assertIn(
            "\n\nPlease respond by Friday, October 9, 2026 at 1:00 PM EDT (America/New_York).\n\n",
            body,
        )
        self.assertNotIn("2026-10-09", body)
        self.assertIn(
            ("Respond by", f"Friday, October 9, 2026 at 1:00{NBSP}PM{NBSP}EDT (America/New_York)"),
            detail_rows(invitation_html_body(invitation)),
        )

        self.event.timezone = "UTC"
        self.assertIn(
            "\n\nPlease respond by Friday, October 9, 2026 at 5:00 PM UTC.\n\n",
            invitation_body(invitation),
        )
        self.assertIn(
            ("Respond by", f"Friday, October 9, 2026 at 5:00{NBSP}PM{NBSP}UTC"),
            detail_rows(invitation_html_body(invitation, reminder=True)),
        )

    def test_only_the_html_parts_keep_times_on_one_line(self):
        invitation = self.invitation()
        self.assertNotIn(NBSP, invitation_body(invitation))
        self.assertNotIn(NBSP, final_confirmation_body(self.event, self.meeting))
        self.assertNotIn(NBSP, final_meeting_ics(self.event, self.meeting).content)
        self.assertIn(f"1:00{NBSP}PM{NBSP}EDT", invitation_html_body(invitation))
        self.assertIn(
            f"10:00{NBSP}AM to 11:30{NBSP}AM{NBSP}EDT",
            final_confirmation_html_body(self.event, self.meeting),
        )

    def test_confirmation_without_a_location_has_no_location_line_or_row(self):
        self.assertEqual(
            final_confirmation_body(self.event, self.meeting),
            "The final meeting time for Planning, round 2 is confirmed.\n\n"
            "When: Monday, September 28, 2026, 10:00 AM to 11:30 AM EDT\n"
            "Timezone: America/New_York\n"
            "Method: Virtual\n"
            "Event: https://app.releviz.test/event?code=TIMES1\n\n"
            "A calendar invitation is attached.",
        )
        self.assertEqual(
            detail_rows(final_confirmation_html_body(self.event, self.meeting)),
            [
                ("When", f"Monday, September 28, 2026, 10:00{NBSP}AM to 11:30{NBSP}AM{NBSP}EDT"),
                ("Timezone", "America/New_York"),
                ("Method", "Virtual"),
            ],
        )

    def test_confirmation_with_a_location_lists_it_last(self):
        self.meeting.timezone = "UTC"
        self.meeting.channel = "inperson"
        self.meeting.location = "Room 4B"
        self.assertIn(
            "\n\nWhen: Monday, September 28, 2026, 2:00 PM to 3:30 PM UTC\n"
            "Timezone: UTC\n"
            "Method: In person\n"
            "Location: Room 4B\n"
            "Event: ",
            final_confirmation_body(self.event, self.meeting),
        )
        self.assertEqual(
            detail_rows(final_confirmation_html_body(self.event, self.meeting)),
            [
                ("When", f"Monday, September 28, 2026, 2:00{NBSP}PM to 3:30{NBSP}PM{NBSP}UTC"),
                ("Timezone", "UTC"),
                ("Method", "In person"),
                ("Location", "Room 4B"),
            ],
        )

    def test_calendar_description_names_a_zone_its_label_does_not(self):
        self.assertEqual(
            ics_description(final_meeting_ics(self.event, self.meeting).content),
            "DESCRIPTION:Confirmed for Monday\\, September 28\\, 2026\\, 10:00 AM to 11:30 AM "
            "EDT (America/New_York). Event page: https://app.releviz.test/event?code=TIMES1",
        )
        self.assertEqual(
            ics_description(final_meeting_ics(self.event, self.meeting, canceled=True).content),
            "DESCRIPTION:Planning\\, round 2 is no longer confirmed for Monday\\, September 28\\, "
            "2026\\, 10:00 AM to 11:30 AM EDT (America/New_York).",
        )

        self.meeting.timezone = "UTC"
        self.assertEqual(
            ics_description(final_meeting_ics(self.event, self.meeting).content),
            "DESCRIPTION:Confirmed for Monday\\, September 28\\, 2026\\, 2:00 PM to 3:30 PM UTC. "
            "Event page: https://app.releviz.test/event?code=TIMES1",
        )
        self.assertEqual(
            ics_description(final_meeting_ics(self.event, self.meeting, canceled=True).content),
            "DESCRIPTION:Planning\\, round 2 is no longer confirmed for Monday\\, September 28\\, "
            "2026\\, 2:00 PM to 3:30 PM UTC.",
        )


class NowrapTimesTests(SimpleTestCase):
    def test_a_time_its_period_and_its_zone_stay_together(self):
        self.assertEqual(
            nowrap_times("Monday, September 28, 2026, 10:00 AM to 11:00 AM EDT"),
            f"Monday, September 28, 2026, 10:00{NBSP}AM to 11:00{NBSP}AM{NBSP}EDT",
        )
        self.assertEqual(
            nowrap_times("Wednesday, July 1, 2026 at 12:00 PM UTC+04:00"),
            f"Wednesday, July 1, 2026 at 12:00{NBSP}PM{NBSP}UTC+04:00",
        )
        self.assertEqual(
            nowrap_times("Sunday, November 1, 2026 at 1:30 AM EST (America/New_York)"),
            f"Sunday, November 1, 2026 at 1:30{NBSP}AM{NBSP}EST (America/New_York)",
        )

    def test_the_word_between_two_times_and_other_text_are_left_alone(self):
        self.assertEqual(
            nowrap_times("10:00 AM to 11:00 AM UTC"), f"10:00{NBSP}AM to 11:00{NBSP}AM{NBSP}UTC"
        )
        self.assertEqual(nowrap_times("Room 4B, AM wing"), "Room 4B, AM wing")
        self.assertEqual(nowrap_times("America/New_York"), "America/New_York")
