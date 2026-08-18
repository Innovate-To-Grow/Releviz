"""Validation and normalization of the event configuration payload."""

from datetime import date

from django.core.exceptions import ValidationError
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.scheduling.models import Event
from apps.scheduling.services.slots import (
    MAX_SPECIFIC_DATES,
    SlotConfigurationError,
    build_event_slot_groups,
    format_time_value,
    parse_time_value,
)
from apps.scheduling.validators import validate_iana_timezone

from .errors import EventManagementError

CONFIGURATION_FIELDS = (
    "name",
    "start_minutes",
    "end_minutes",
    "slot_minutes",
    "spans_next_day",
    "days",
    "mode",
    "location",
    "participant_view_permission",
    "day_selection_type",
    "specific_dates",
    "response_deadline",
    "timezone",
    "reminders_enabled",
    "reminder_hours_before",
    "access_mode",
    "meeting_duration_minutes",
)
GEOMETRY_FIELDS = {
    "start_minutes",
    "end_minutes",
    "slot_minutes",
    "spans_next_day",
    "days",
    "day_selection_type",
    "specific_dates",
    "timezone",
}
RESULT_FIELDS = GEOMETRY_FIELDS | {
    "mode",
    "meeting_duration_minutes",
}


def _value(data, key, existing, attribute, default):
    if key in data:
        return data.get(key)
    if existing is not None:
        return getattr(existing, attribute)
    return default


def parse_event_configuration(data, *, existing=None) -> dict:
    name = str(_value(data, "name", existing, "name", "") or "").strip()
    if not name:
        raise EventManagementError("Name is required")
    if len(name) > 200:
        raise EventManagementError("Event name too long (max 200)")

    if "startHour" in data or "endHour" in data:
        raise EventManagementError("Use startTime and endTime in HH:MM format.")
    raw_start = (
        data.get("startTime")
        if "startTime" in data
        else format_time_value(existing.start_minutes)
        if existing is not None
        else "09:00"
    )
    raw_end = (
        data.get("endTime")
        if "endTime" in data
        else format_time_value(existing.end_minutes)
        if existing is not None
        else "17:00"
    )
    try:
        start_minutes = parse_time_value(raw_start, "startTime")
        end_minutes = parse_time_value(raw_end, "endTime")
    except SlotConfigurationError as exc:
        raise EventManagementError(str(exc)) from exc
    if start_minutes == end_minutes:
        raise EventManagementError("Event start and end times must be different.")
    spans_next_day = end_minutes < start_minutes

    slot_minutes = _value(data, "slotMinutes", existing, "slot_minutes", 30)
    if (
        isinstance(slot_minutes, bool)
        or not isinstance(slot_minutes, int)
        or slot_minutes not in {15, 30}
    ):
        raise EventManagementError("slotMinutes must be 15 or 30.")

    mode = str(_value(data, "mode", existing, "mode", "inperson") or "inperson")
    if mode not in {"virtual", "inperson", "mixed"}:
        raise EventManagementError("Invalid mode. Must be 'inperson', 'virtual', or 'mixed'")
    raw_location = _value(data, "location", existing, "location", "")
    location = "" if mode == "virtual" else (str(raw_location or "").strip() or "TBD")
    if len(location) > 500:
        raise EventManagementError("Location too long (max 500)")

    day_selection_type = str(
        _value(data, "daySelectionType", existing, "day_selection_type", "days_of_week")
        or "days_of_week"
    )
    if day_selection_type not in {"days_of_week", "specific_dates"}:
        raise EventManagementError("Invalid daySelectionType")
    if day_selection_type == "specific_dates":
        if "specificDates" in data:
            specific_dates = data.get("specificDates")
        elif existing is not None and existing.day_selection_type == "specific_dates":
            specific_dates = existing.specific_dates
        else:
            specific_dates = None
        if not isinstance(specific_dates, list) or not specific_dates:
            raise EventManagementError("specificDates must be a non-empty array")
        if len(specific_dates) > MAX_SPECIFIC_DATES:
            raise EventManagementError(
                f"specificDates may contain at most {MAX_SPECIFIC_DATES} dates"
            )
        parsed_dates = []
        try:
            for item in specific_dates:
                parsed = date.fromisoformat(item)
                if parsed.isoformat() != item:
                    raise ValueError
                parsed_dates.append(item)
        except (TypeError, ValueError) as exc:
            raise EventManagementError(
                "specificDates must be ISO date strings (YYYY-MM-DD)"
            ) from exc
        if len(set(parsed_dates)) != len(parsed_dates):
            raise EventManagementError("specificDates must not contain duplicates")
        specific_dates = sorted(parsed_dates)
        selected_days = []
    else:
        specific_dates = None
        if "days" in data:
            selected_days = data.get("days")
        elif existing is not None and existing.day_selection_type == "days_of_week":
            selected_days = existing.days
        else:
            selected_days = [1, 2, 3, 4, 5]
        if (
            not isinstance(selected_days, list)
            or not selected_days
            or any(
                isinstance(day, bool) or not isinstance(day, int) or day < 0 or day > 6
                for day in selected_days
            )
        ):
            raise EventManagementError("days must be a non-empty array of integers 0-6")
        selected_days = sorted(set(selected_days))

    view_permission = str(
        _value(
            data,
            "participantViewPermission",
            existing,
            "participant_view_permission",
            "own_only",
        )
        or "own_only"
    )
    if view_permission == "all":
        view_permission = "all_after_submit"
    if view_permission not in {"own_only", "all_after_submit", "realtime"}:
        raise EventManagementError("Invalid participantViewPermission value")

    event_timezone = str(_value(data, "timezone", existing, "timezone", "UTC") or "").strip()
    try:
        validate_iana_timezone(event_timezone)
    except ValidationError as exc:
        raise EventManagementError("timezone must be a valid IANA timezone") from exc

    if "responseDeadline" in data:
        raw_deadline = data.get("responseDeadline")
        if raw_deadline:
            response_deadline = parse_datetime(str(raw_deadline))
            if response_deadline is None:
                raise EventManagementError("responseDeadline must be an ISO datetime")
            if timezone.is_naive(response_deadline):
                response_deadline = timezone.make_aware(response_deadline)
        else:
            response_deadline = None
    else:
        response_deadline = existing.response_deadline if existing is not None else None

    reminders_enabled = _value(
        data,
        "remindersEnabled",
        existing,
        "reminders_enabled",
        True,
    )
    if not isinstance(reminders_enabled, bool):
        raise EventManagementError("remindersEnabled must be a boolean")
    reminder_hours_before = _value(
        data,
        "reminderHoursBefore",
        existing,
        "reminder_hours_before",
        24,
    )
    if isinstance(reminder_hours_before, bool):
        raise EventManagementError("reminderHoursBefore must be an integer")
    try:
        reminder_hours_before = int(reminder_hours_before)
    except (TypeError, ValueError) as exc:
        raise EventManagementError("reminderHoursBefore must be an integer") from exc
    if reminder_hours_before < 0 or reminder_hours_before > 720:
        raise EventManagementError("reminderHoursBefore must be between 0 and 720")

    access_mode = str(
        _value(data, "accessMode", existing, "access_mode", "invite_only") or "invite_only"
    )
    if access_mode not in {"invite_only", "open_link"}:
        raise EventManagementError("accessMode must be 'invite_only' or 'open_link'")

    meeting_duration_minutes = _value(
        data,
        "meetingDurationMinutes",
        existing,
        "meeting_duration_minutes",
        30,
    )
    if isinstance(meeting_duration_minutes, bool):
        raise EventManagementError("meetingDurationMinutes must be an integer")
    try:
        meeting_duration_minutes = int(meeting_duration_minutes)
    except (TypeError, ValueError) as exc:
        raise EventManagementError("meetingDurationMinutes must be an integer") from exc
    if meeting_duration_minutes < 15 or meeting_duration_minutes > 480:
        raise EventManagementError("meetingDurationMinutes must be between 15 and 480")
    if meeting_duration_minutes % slot_minutes:
        raise EventManagementError("meetingDurationMinutes must be a multiple of slotMinutes")

    candidate = Event(
        start_minutes=start_minutes,
        end_minutes=end_minutes,
        slot_minutes=slot_minutes,
        spans_next_day=spans_next_day,
        days=selected_days,
        day_selection_type=day_selection_type,
        specific_dates=specific_dates,
        timezone=event_timezone,
    )
    try:
        slot_groups = build_event_slot_groups(candidate)
    except SlotConfigurationError as exc:
        raise EventManagementError(str(exc)) from exc
    required_slots = meeting_duration_minutes // slot_minutes
    if not any(len(group.slots) >= required_slots for group in slot_groups):
        raise EventManagementError("meetingDurationMinutes does not fit within any configured day")

    return {
        "name": name,
        "start_minutes": start_minutes,
        "end_minutes": end_minutes,
        "slot_minutes": slot_minutes,
        "spans_next_day": spans_next_day,
        "days": selected_days,
        "mode": mode,
        "location": location,
        "participant_view_permission": view_permission,
        "day_selection_type": day_selection_type,
        "specific_dates": specific_dates,
        "response_deadline": response_deadline,
        "timezone": event_timezone,
        "reminders_enabled": reminders_enabled,
        "reminder_hours_before": reminder_hours_before,
        "access_mode": access_mode,
        "meeting_duration_minutes": meeting_duration_minutes,
    }
