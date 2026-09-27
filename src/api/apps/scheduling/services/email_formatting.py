"""Times and labels as event emails show them to recipients.

Recipients read these strings, so they spell out the weekday, month, clock,
and zone instead of an ISO timestamp or a stored code. They are built from
datetime fields and fixed English names, so the output never depends on the
process locale or on Django's language settings. Previews call the same email
builders as the send, so they show exactly these strings too.
"""

import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apps.scheduling.models import FinalMeeting

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
METHOD_LABELS = dict(FinalMeeting.CHANNEL_CHOICES)
NO_BREAK_SPACE = "\u00a0"
_CLOCK_THEN_PERIOD = re.compile(r"(\d{1,2}:\d{2}) ([AP]M)\b")
_PERIOD_THEN_ZONE = re.compile(r"\b([AP]M) (UTC[+-]\d{2}:\d{2}|[A-Z]{2,6})\b")


def _known_zone(tz_name: str) -> ZoneInfo | None:
    if not tz_name:
        return None
    try:
        return ZoneInfo(tz_name)
    except (TypeError, ValueError, ZoneInfoNotFoundError):
        return None


def local_datetime(value: datetime, tz_name: str) -> datetime:
    """``value`` in the zone ``tz_name``.

    A naive value is taken as UTC, and an unknown or empty zone falls back to
    UTC: events validate their zone, but sending email must never fail on it.
    """

    aware = value if value.utcoffset() is not None else value.replace(tzinfo=UTC)
    return aware.astimezone(_known_zone(tz_name) or UTC)


def zone_label(value: datetime) -> str:
    """The zone an aware local datetime is shown in: ``UTC``, ``EDT``, ``UTC+05:45``."""

    name = value.tzname() or ""
    if name.isascii() and name.isalpha():
        return name
    offset = value.utcoffset() or timedelta(0)
    if not offset:
        return "UTC"
    sign = "-" if offset < timedelta(0) else "+"
    hours, minutes = divmod(abs(offset) // timedelta(minutes=1), 60)
    return f"UTC{sign}{hours:02d}:{minutes:02d}"


def zone_suffix(tz_name: str, label: str) -> str:
    """`` (America/Los_Angeles)`` when the label shown does not already name the zone."""

    if tz_name == label or _known_zone(tz_name) is None:
        return ""
    return f" ({tz_name})"


def _date(local: datetime) -> str:
    return f"{WEEKDAYS[local.weekday()]}, {MONTHS[local.month - 1]} {local.day}, {local.year:04d}"


def _clock(local: datetime) -> str:
    period = "AM" if local.hour < 12 else "PM"
    return f"{local.hour % 12 or 12}:{local.minute:02d} {period}"


def format_email_datetime(value: datetime, tz_name: str) -> str:
    """``Friday, October 9, 2026 at 5:00 PM UTC``."""

    local = local_datetime(value, tz_name)
    return f"{_date(local)} at {_clock(local)} {zone_label(local)}"


def format_email_time_range(start: datetime, end: datetime, tz_name: str) -> str:
    """``Monday, September 28, 2026, 10:00 AM to 11:00 AM UTC``.

    A range that crosses local midnight, or whose zone label changes across a
    daylight saving switch, spells out both ends in full.
    """

    local_start = local_datetime(start, tz_name)
    local_end = local_datetime(end, tz_name)
    label = zone_label(local_start)
    if local_start.date() == local_end.date() and label == zone_label(local_end):
        return f"{_date(local_start)}, {_clock(local_start)} to {_clock(local_end)} {label}"
    return f"{format_email_datetime(start, tz_name)} to {format_email_datetime(end, tz_name)}"


def meeting_method_label(channel: str) -> str:
    """``In person`` or ``Virtual``; an unrecognized value is shown as stored."""

    return METHOD_LABELS.get(channel, channel)


def nowrap_times(text: str) -> str:
    """``text`` with each clock time kept on one line, for the HTML parts.

    A narrow email column would otherwise break ``11:00 AM EDT`` after
    ``11:00``. Only the spaces inside a time and before its zone become
    no-break spaces; the plain-text parts keep ordinary spaces.
    """

    text = _CLOCK_THEN_PERIOD.sub(rf"\1{NO_BREAK_SPACE}\2", text)
    return _PERIOD_THEN_ZONE.sub(rf"\1{NO_BREAK_SPACE}\2", text)
