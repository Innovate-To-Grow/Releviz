"""Slot geometry for an event window, and the availability arrays derived from it."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

MINUTES_PER_DAY = 24 * 60
SUPPORTED_SLOT_MINUTES = (15, 30)
MAX_SPECIFIC_DATES = 31
MAX_EVENT_SLOTS = 1000
WEEKDAY_LABELS = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")


class SlotConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class EventSlot:
    index: int
    local_start: str
    local_end: str
    start_day_offset: int
    end_day_offset: int
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    start_offset: str | None = None
    end_offset: str | None = None
    fold: int | None = None

    def as_api(self) -> dict:
        data = {
            "index": self.index,
            "localStart": self.local_start,
            "localEnd": self.local_end,
            "startDayOffset": self.start_day_offset,
            "endDayOffset": self.end_day_offset,
        }
        if self.starts_at is not None:
            data.update(
                {
                    "startsAt": self.starts_at.astimezone(UTC).isoformat(),
                    "endsAt": self.ends_at.astimezone(UTC).isoformat(),
                    "startOffset": self.start_offset,
                    "endOffset": self.end_offset,
                    "fold": self.fold,
                }
            )
        return data


@dataclass(frozen=True)
class EventSlotGroup:
    key: str
    label: str
    slots: tuple[EventSlot, ...]
    weekday: int | None = None
    date_value: str | None = None

    def as_api(self) -> dict:
        data = {
            "key": self.key,
            "label": self.label,
            "slots": [slot.as_api() for slot in self.slots],
        }
        if self.weekday is not None:
            data["weekday"] = self.weekday
        if self.date_value is not None:
            data["date"] = self.date_value
        return data


def parse_time_value(value, label: str) -> int:
    if not isinstance(value, str):
        raise SlotConfigurationError(f"{label} must use HH:MM format.")
    parts = value.split(":")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise SlotConfigurationError(f"{label} must use HH:MM format.")
    hour, minute = (int(part) for part in parts)
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise SlotConfigurationError(f"{label} must be a valid time.")
    return hour * 60 + minute


def format_time_value(minutes: int) -> str:
    normalized = minutes % MINUTES_PER_DAY
    return f"{normalized // 60:02d}:{normalized % 60:02d}"


def event_window_duration_minutes(event) -> int:
    duration = event.end_minutes - event.start_minutes
    if event.spans_next_day:
        duration += MINUTES_PER_DAY
    if duration <= 0 or duration > MINUTES_PER_DAY:
        raise SlotConfigurationError("The event window direction is invalid.")
    return duration


def validate_minute_configuration(event) -> None:
    if event.slot_minutes not in SUPPORTED_SLOT_MINUTES:
        raise SlotConfigurationError("slotMinutes must be 15 or 30.")
    if not 0 <= event.start_minutes < MINUTES_PER_DAY:
        raise SlotConfigurationError("startTime must be a valid time.")
    if not 0 <= event.end_minutes < MINUTES_PER_DAY:
        raise SlotConfigurationError("endTime must be a valid time.")
    if event.spans_next_day and event.end_minutes > event.start_minutes:
        raise SlotConfigurationError("An overnight event must end at or before its start time.")
    if not event.spans_next_day and event.end_minutes <= event.start_minutes:
        raise SlotConfigurationError("Event start and end times must be different.")
    event_window_duration_minutes(event)
    if event.start_minutes % event.slot_minutes or event.end_minutes % event.slot_minutes:
        raise SlotConfigurationError(
            f"Start and end times must align to {event.slot_minutes}-minute slots."
        )


def _offset_text(value: datetime) -> str:
    raw = value.strftime("%z")
    return f"{raw[:3]}:{raw[3:]}"


def _valid_localizations(value: datetime, zone: ZoneInfo) -> list[datetime]:
    candidates = {}
    for fold in (0, 1):
        candidate = value.replace(tzinfo=zone, fold=fold)
        round_trip = candidate.astimezone(UTC).astimezone(zone).replace(tzinfo=None)
        if round_trip == value:
            candidates[candidate.astimezone(UTC)] = candidate
    return [candidates[key] for key in sorted(candidates)]


def valid_localizations(value: datetime, zone: ZoneInfo) -> tuple[datetime, ...]:
    return tuple(_valid_localizations(value, zone))


def _resolve_boundary(value: datetime, zone: ZoneInfo, *, is_start: bool) -> datetime:
    candidates = _valid_localizations(value, zone)
    if not candidates:
        raise SlotConfigurationError(
            f"{value.isoformat(timespec='minutes')} is a nonexistent local time in {zone.key}."
        )
    return candidates[0] if is_start else candidates[-1]


def _weekly_groups(event) -> list[EventSlotGroup]:
    selected_days = sorted(set(event.days or []))
    if not selected_days or any(
        isinstance(day, bool) or not isinstance(day, int) or day < 0 or day > 6
        for day in selected_days
    ):
        raise SlotConfigurationError("A weekly event must contain valid days 0-6.")

    duration = event_window_duration_minutes(event)
    slots_per_group = duration // event.slot_minutes
    groups = []
    index = 0
    for weekday in selected_days:
        slots = []
        for row in range(slots_per_group):
            start_total = event.start_minutes + row * event.slot_minutes
            end_total = start_total + event.slot_minutes
            slots.append(
                EventSlot(
                    index=index,
                    local_start=format_time_value(start_total),
                    local_end=format_time_value(end_total),
                    start_day_offset=start_total // MINUTES_PER_DAY,
                    end_day_offset=end_total // MINUTES_PER_DAY,
                )
            )
            index += 1
        groups.append(
            EventSlotGroup(
                key=f"weekday:{weekday}",
                label=WEEKDAY_LABELS[weekday],
                weekday=weekday,
                slots=tuple(slots),
            )
        )
    return groups


def _specific_date_groups(event) -> list[EventSlotGroup]:
    configured_dates = event.specific_dates
    if not isinstance(configured_dates, list) or not configured_dates:
        raise SlotConfigurationError("A specific-date event must contain at least one date.")

    zone = ZoneInfo(event.timezone)
    groups = []
    index = 0
    for raw_date in configured_dates:
        try:
            base_date = date.fromisoformat(raw_date)
        except (TypeError, ValueError) as exc:
            raise SlotConfigurationError("specificDates must contain valid ISO dates.") from exc
        end_date = base_date
        if event.spans_next_day:
            end_date += timedelta(days=1)

        start_naive = datetime.combine(base_date, datetime.min.time()) + timedelta(
            minutes=event.start_minutes
        )
        end_naive = datetime.combine(end_date, datetime.min.time()) + timedelta(
            minutes=event.end_minutes
        )
        starts_at = _resolve_boundary(start_naive, zone, is_start=True).astimezone(UTC)
        ends_at = _resolve_boundary(end_naive, zone, is_start=False).astimezone(UTC)
        if ends_at <= starts_at:
            raise SlotConfigurationError(
                f"The event window on {raw_date} does not contain any real elapsed time."
            )

        elapsed_seconds = int((ends_at - starts_at).total_seconds())
        slot_seconds = event.slot_minutes * 60
        if elapsed_seconds % slot_seconds:
            raise SlotConfigurationError(
                f"The event window on {raw_date} cannot be divided into "
                f"{event.slot_minutes}-minute slots."
            )

        slots = []
        current = starts_at
        while current < ends_at:
            following = current + timedelta(minutes=event.slot_minutes)
            start_local = current.astimezone(zone)
            end_local = following.astimezone(zone)
            slots.append(
                EventSlot(
                    index=index,
                    local_start=start_local.strftime("%H:%M"),
                    local_end=end_local.strftime("%H:%M"),
                    start_day_offset=(start_local.date() - base_date).days,
                    end_day_offset=(end_local.date() - base_date).days,
                    starts_at=current,
                    ends_at=following,
                    start_offset=_offset_text(start_local),
                    end_offset=_offset_text(end_local),
                    fold=start_local.fold,
                )
            )
            index += 1
            current = following

        groups.append(
            EventSlotGroup(
                key=f"date:{raw_date}",
                label=raw_date,
                date_value=raw_date,
                slots=tuple(slots),
            )
        )
    return groups


def build_event_slot_groups(event) -> tuple[EventSlotGroup, ...]:
    validate_minute_configuration(event)
    if event.day_selection_type == "specific_dates":
        groups = tuple(_specific_date_groups(event))
    elif event.day_selection_type == "days_of_week":
        groups = tuple(_weekly_groups(event))
    else:
        raise SlotConfigurationError("Invalid daySelectionType.")
    slot_count = sum(len(group.slots) for group in groups)
    if slot_count > MAX_EVENT_SLOTS:
        raise SlotConfigurationError(
            f"An event may contain at most {MAX_EVENT_SLOTS} availability slots."
        )
    return groups


def event_slot_count(event) -> int:
    """Count slots without materializing the full API slot geometry.

    Availability writes validate two channel arrays. Building every
    ``EventSlot`` for each validation made a 1,000-slot submission spend most
    of its time formatting timezone-aware API data. Counting only needs the
    number of selected groups and, for dated events, each group's UTC
    boundaries so DST folds and gaps remain authoritative.
    """

    validate_minute_configuration(event)
    duration = event_window_duration_minutes(event)

    if event.day_selection_type == "days_of_week":
        selected_days = sorted(set(event.days or []))
        if not selected_days or any(
            isinstance(day, bool) or not isinstance(day, int) or day < 0 or day > 6
            for day in selected_days
        ):
            raise SlotConfigurationError("A weekly event must contain valid days 0-6.")
        slot_count = len(selected_days) * (duration // event.slot_minutes)
    elif event.day_selection_type == "specific_dates":
        configured_dates = event.specific_dates
        if not isinstance(configured_dates, list) or not configured_dates:
            raise SlotConfigurationError("A specific-date event must contain at least one date.")

        zone = ZoneInfo(event.timezone)
        slot_seconds = event.slot_minutes * 60
        slot_count = 0
        for raw_date in configured_dates:
            try:
                base_date = date.fromisoformat(raw_date)
            except (TypeError, ValueError) as exc:
                raise SlotConfigurationError("specificDates must contain valid ISO dates.") from exc
            end_date = base_date + timedelta(days=int(event.spans_next_day))
            start_naive = datetime.combine(base_date, datetime.min.time()) + timedelta(
                minutes=event.start_minutes
            )
            end_naive = datetime.combine(end_date, datetime.min.time()) + timedelta(
                minutes=event.end_minutes
            )
            starts_at = _resolve_boundary(start_naive, zone, is_start=True).astimezone(UTC)
            ends_at = _resolve_boundary(end_naive, zone, is_start=False).astimezone(UTC)
            if ends_at <= starts_at:
                raise SlotConfigurationError(
                    f"The event window on {raw_date} does not contain any real elapsed time."
                )
            elapsed_seconds = int((ends_at - starts_at).total_seconds())
            if elapsed_seconds % slot_seconds:
                raise SlotConfigurationError(
                    f"The event window on {raw_date} cannot be divided into "
                    f"{event.slot_minutes}-minute slots."
                )
            slot_count += elapsed_seconds // slot_seconds
    else:
        raise SlotConfigurationError("Invalid daySelectionType.")

    if slot_count > MAX_EVENT_SLOTS:
        raise SlotConfigurationError(
            f"An event may contain at most {MAX_EVENT_SLOTS} availability slots."
        )
    return slot_count


def api_slot_groups(event) -> list[dict]:
    return [group.as_api() for group in build_event_slot_groups(event)]


def expected_availability_length(event) -> int:
    return event_slot_count(event)


def default_availability(event) -> list[int]:
    return [0] * expected_availability_length(event)


def validate_availability(availability, event, label: str):
    """Check one request-supplied availability array against the event geometry.

    Unlike the rest of this module this returns the message instead of raising:
    the caller is a view turning it straight into a 400 response body.
    """

    if not isinstance(availability, list):
        return f"Invalid {label}: must be an array"
    expected = expected_availability_length(event)
    if len(availability) != expected:
        return f"Invalid {label}: expected {expected} slots, got {len(availability)}"
    if not all(
        not isinstance(value, bool) and isinstance(value, int | float) and 0 <= value <= 1
        for value in availability
    ):
        return f"Invalid {label}: values must be numbers between 0 and 1"
    return None
