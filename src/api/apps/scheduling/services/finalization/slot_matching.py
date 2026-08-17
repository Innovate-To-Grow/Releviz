"""Match a requested final meeting time against the event slot geometry."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

from apps.scheduling.models import Event
from apps.scheduling.services.slots import (
    SlotConfigurationError,
    build_event_slot_groups,
    event_window_duration_minutes,
    valid_localizations,
)

from .errors import FinalizationError


def _matching_absolute_slot_indices(
    event: Event,
    starts_at: datetime,
    ends_at: datetime,
) -> list[int]:
    try:
        groups = build_event_slot_groups(event)
    except SlotConfigurationError as exc:
        raise FinalizationError(str(exc)) from exc

    for group in groups:
        if not group.slots:
            continue
        if starts_at < group.slots[0].starts_at or ends_at > group.slots[-1].ends_at:
            continue
        selected = [
            slot for slot in group.slots if slot.starts_at >= starts_at and slot.ends_at <= ends_at
        ]
        if (
            selected
            and selected[0].starts_at == starts_at
            and selected[-1].ends_at == ends_at
            and all(
                current.ends_at == following.starts_at
                for current, following in zip(selected, selected[1:], strict=False)
            )
        ):
            return [slot.index for slot in selected]

    raise FinalizationError(
        f"The final meeting must match one or more complete "
        f"{event.slot_minutes}-minute slots on a configured event date."
    )


def _weekly_slot_indices(
    event: Event,
    starts_at: datetime,
    ends_at: datetime,
    zone: ZoneInfo,
) -> list[int]:
    start_local = starts_at.astimezone(zone)
    selected_days = sorted(set(event.days or []))
    duration = event_window_duration_minutes(event)
    slots_per_group = duration // event.slot_minutes
    base_dates = [start_local.date()]
    if event.spans_next_day:
        base_dates.append(start_local.date() - timedelta(days=1))

    dst_error = None
    enabled_candidate = False
    for base_date in base_dates:
        weekday = (base_date.weekday() + 1) % 7
        if weekday not in selected_days:
            continue
        enabled_candidate = True
        base_midnight = datetime.combine(base_date, datetime.min.time())
        start_naive = starts_at.astimezone(zone).replace(tzinfo=None)
        end_naive = ends_at.astimezone(zone).replace(tzinfo=None)
        start_from_midnight = int((start_naive - base_midnight).total_seconds() // 60)
        end_from_midnight = int((end_naive - base_midnight).total_seconds() // 60)
        relative_start = start_from_midnight - event.start_minutes
        relative_end = end_from_midnight - event.start_minutes
        if (
            relative_start < 0
            or relative_end > duration
            or relative_end <= relative_start
            or relative_start % event.slot_minutes
            or relative_end % event.slot_minutes
        ):
            continue

        start_row = relative_start // event.slot_minutes
        end_row = relative_end // event.slot_minutes
        resolved_boundaries = []
        invalid = False
        for row in range(start_row, end_row + 1):
            boundary = base_midnight + timedelta(
                minutes=event.start_minutes + row * event.slot_minutes
            )
            candidates = valid_localizations(boundary, zone)
            if not candidates:
                dst_error = (
                    "The selected time contains a nonexistent local slot caused by "
                    "daylight saving time."
                )
                invalid = True
                break
            if len(candidates) > 1:
                dst_error = (
                    "The selected time contains an ambiguous local slot caused by "
                    "daylight saving time."
                )
                invalid = True
                break
            resolved_boundaries.append(candidates[0].astimezone(UTC))
        if invalid:
            continue
        if resolved_boundaries[0] != starts_at or resolved_boundaries[-1] != ends_at:
            continue

        group_position = selected_days.index(weekday)
        group_start = group_position * slots_per_group
        return list(range(group_start + start_row, group_start + end_row))

    if dst_error:
        raise FinalizationError(dst_error)
    if not enabled_candidate:
        raise FinalizationError("The final meeting day is not enabled for this event.")
    raise FinalizationError(
        f"The final meeting must fit inside the event window and align to "
        f"{event.slot_minutes}-minute slots."
    )


def normalize_final_time(
    event: Event,
    *,
    starts_at: datetime,
    ends_at: datetime,
    channel: str,
    location: str,
) -> dict:
    if timezone.is_naive(starts_at) or timezone.is_naive(ends_at):
        raise FinalizationError("Final meeting timestamps must include an explicit UTC offset.")
    starts_at = starts_at.astimezone(UTC)
    ends_at = ends_at.astimezone(UTC)
    if ends_at <= starts_at:
        raise FinalizationError("Final meeting end time must be after its start time.")

    allowed_channels = {
        "inperson": {"inperson"},
        "virtual": {"virtual"},
        "mixed": {"inperson", "virtual"},
    }[event.mode]
    if channel not in allowed_channels:
        raise FinalizationError(f"{channel or 'The selected channel'} is not valid for this event.")

    zone = ZoneInfo(event.timezone)
    start_local = starts_at.astimezone(zone)
    end_local = ends_at.astimezone(zone)
    if event.day_selection_type == "specific_dates":
        slot_indices = _matching_absolute_slot_indices(event, starts_at, ends_at)
    else:
        slot_indices = _weekly_slot_indices(event, starts_at, ends_at, zone)

    expected_duration = int(getattr(event, "meeting_duration_minutes", event.slot_minutes))
    actual_duration = int((ends_at - starts_at).total_seconds() // 60)
    if actual_duration != expected_duration:
        raise FinalizationError(
            f"The final meeting must be exactly {expected_duration} minutes long."
        )

    normalized_location = str(location or "").strip()
    if not normalized_location:
        normalized_location = event.location.strip() or (
            "Online" if channel == "virtual" else "Location to be confirmed"
        )
    if len(normalized_location) > 500:
        raise FinalizationError("Final meeting location is too long (max 500).")

    return {
        "starts_at": starts_at,
        "ends_at": ends_at,
        "start_local": start_local,
        "end_local": end_local,
        "slot_indices": slot_indices,
        "channel": channel,
        "location": normalized_location,
    }
