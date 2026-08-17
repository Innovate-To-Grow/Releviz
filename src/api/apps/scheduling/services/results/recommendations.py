"""Rank the best meeting windows for an event."""

from __future__ import annotations

from collections import deque
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

from apps.scheduling.services.slots import build_event_slot_groups, valid_localizations

MAX_RECOMMENDATIONS = 10


def _as_utc(value: datetime) -> datetime:
    if timezone.is_naive(value):
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _meeting_duration_minutes(event) -> int:
    """Return the configured duration, with a fallback for lightweight test doubles."""

    return int(getattr(event, "meeting_duration_minutes", event.slot_minutes))


def _weekly_suggestion(event, group, slots, current_time: datetime):
    zone = ZoneInfo(event.timezone)
    current_time = _as_utc(current_time)
    local_today = current_time.astimezone(zone).date()
    first_slot = slots[0]

    for day_offset in range(15):
        base_date = local_today + timedelta(days=day_offset)
        weekday = (base_date.weekday() + 1) % 7
        if weekday != group.weekday:
            continue

        boundaries = [
            datetime.combine(
                base_date + timedelta(days=first_slot.start_day_offset),
                time.fromisoformat(first_slot.local_start),
            ),
            *[
                datetime.combine(
                    base_date + timedelta(days=slot.end_day_offset),
                    time.fromisoformat(slot.local_end),
                )
                for slot in slots
            ],
        ]
        localized_boundaries = [valid_localizations(boundary, zone) for boundary in boundaries]
        if any(len(candidates) != 1 for candidates in localized_boundaries):
            continue
        starts_at = localized_boundaries[0][0].astimezone(UTC)
        ends_at = localized_boundaries[-1][0].astimezone(UTC)
        if starts_at >= current_time and ends_at > starts_at:
            return starts_at, ends_at
    return None


def _window_suggestion(event, group, slots, current_time: datetime):
    first_slot = slots[0]
    last_slot = slots[-1]
    if first_slot.starts_at is not None and last_slot.ends_at is not None:
        starts_at = first_slot.starts_at.astimezone(UTC)
        if starts_at < _as_utc(current_time):
            return None
        return starts_at, last_slot.ends_at.astimezone(UTC)
    return _weekly_suggestion(event, group, slots, current_time)


def _window_label(group, slots) -> str:
    first_slot = slots[0]
    last_slot = slots[-1]
    start_suffix = f" +{first_slot.start_day_offset}d" if first_slot.start_day_offset else ""
    end_suffix = f" +{last_slot.end_day_offset}d" if last_slot.end_day_offset else ""
    return f"{group.label} {first_slot.local_start}{start_suffix}–{last_slot.local_end}{end_suffix}"


def _sliding_window_minima(values: list[float], slots, window_size: int) -> list[float]:
    """Return one minimum per contiguous window in linear time."""

    minima: list[float] = []
    candidates: deque[tuple[int, float]] = deque()
    for position, slot in enumerate(slots):
        value = values[slot.index]
        while candidates and candidates[-1][1] >= value:
            candidates.pop()
        candidates.append((position, value))
        first_position = position - window_size + 1
        while candidates and candidates[0][0] < first_position:
            candidates.popleft()
        if first_position >= 0:
            minima.append(candidates[0][1])
    return minima


def build_ranked_recommendations(
    event,
    *,
    classified: dict,
    channel_results: dict,
    now: datetime | None = None,
) -> tuple[list[dict], dict]:
    counted = classified["counted"]
    duration_minutes = _meeting_duration_minutes(event)
    duration_is_valid = (
        duration_minutes >= event.slot_minutes and duration_minutes % event.slot_minutes == 0
    )
    window_size = duration_minutes // event.slot_minutes if duration_is_valid else 0
    basis = {
        "candidateDurationMinutes": duration_minutes,
        "candidateSlotTotal": window_size,
        "maximumRecommendations": MAX_RECOMMENDATIONS,
        "usesSubmittedResponsesOnly": True,
        "participantWindowScore": "minimumAvailability",
        "order": [
            "highestWeightedAvailability",
            "highestUnweightedAvailability",
            "mostFullyAvailableParticipants",
            "earliestConfiguredTime",
        ],
        "status": "waiting_for_submissions" if not counted else "ready",
    }
    if not counted:
        return [], basis
    if not duration_is_valid:
        basis["status"] = "invalid_duration"
        return [], basis

    current_time = now or timezone.now()
    groups = build_event_slot_groups(event)
    channel_positions = {
        channel: position for position, channel in enumerate(channel_results.keys())
    }
    counted_total = len(counted)
    total_weight = sum(entry["weight"] for entry in counted if entry["weight"] > 0)
    candidates = []

    for channel in channel_results:
        for group in groups:
            if len(group.slots) < window_size:
                continue
            windows = [
                group.slots[position : position + window_size]
                for position in range(len(group.slots) - window_size + 1)
            ]
            suggestions = [
                _window_suggestion(event, group, slots, current_time) for slots in windows
            ]
            metrics = [
                {
                    "weightedTotal": 0.0,
                    "unweightedTotal": 0.0,
                    "fullyAvailable": 0,
                    "partiallyAvailable": 0,
                    "unavailable": 0,
                }
                for _window in windows
            ]

            for entry in counted:
                minima = _sliding_window_minima(
                    entry["availability"][channel],
                    group.slots,
                    window_size,
                )
                weight = entry["weight"]
                for position, value in enumerate(minima):
                    metric = metrics[position]
                    metric["unweightedTotal"] += value
                    if weight > 0:
                        metric["weightedTotal"] += value * weight
                    if value >= 1:
                        metric["fullyAvailable"] += 1
                    elif value > 0:
                        metric["partiallyAvailable"] += 1
                    else:
                        metric["unavailable"] += 1

            for position, (slots, suggestion, metric) in enumerate(
                zip(windows, suggestions, metrics, strict=True)
            ):
                if suggestion is None:
                    continue
                starts_at, ends_at = suggestion
                raw_weighted_score = metric["weightedTotal"] / total_weight if total_weight else 0.0
                raw_unweighted_score = metric["unweightedTotal"] / counted_total
                first_slot = slots[0]
                last_slot = slots[-1]
                candidates.append(
                    {
                        "channel": channel,
                        "slotIndex": first_slot.index,
                        "endSlotIndex": last_slot.index,
                        "slotIndices": [slot.index for slot in slots],
                        "durationMinutes": duration_minutes,
                        "groupKey": group.key,
                        "groupLabel": group.label,
                        "weekday": group.weekday,
                        "date": group.date_value,
                        "localStart": first_slot.local_start,
                        "localEnd": last_slot.local_end,
                        "startDayOffset": first_slot.start_day_offset,
                        "endDayOffset": last_slot.end_day_offset,
                        "suggestedStartsAt": starts_at.isoformat(),
                        "suggestedEndsAt": ends_at.isoformat(),
                        "label": _window_label(group, slots),
                        "weightedAvailability": round(raw_weighted_score, 4),
                        "unweightedAvailability": round(raw_unweighted_score, 4),
                        "fullyAvailableParticipantTotal": metric["fullyAvailable"],
                        "partiallyAvailableParticipantTotal": metric["partiallyAvailable"],
                        "unavailableParticipantTotal": metric["unavailable"],
                        "_sort": (
                            -raw_weighted_score,
                            -raw_unweighted_score,
                            -metric["fullyAvailable"],
                            first_slot.index,
                            channel_positions[channel],
                            position,
                        ),
                    }
                )

    candidates.sort(key=lambda candidate: candidate["_sort"])
    recommendations = []
    for rank, candidate in enumerate(candidates[:MAX_RECOMMENDATIONS], start=1):
        candidate.pop("_sort")
        candidate["rank"] = rank
        recommendations.append(candidate)
    if not recommendations:
        basis["status"] = "no_future_slots"
    return recommendations, basis
