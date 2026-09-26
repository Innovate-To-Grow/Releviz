"""Rank the best meeting windows for an event."""

from __future__ import annotations

from collections import deque
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

from apps.scheduling.services.slots import (
    blocked_slot_indices,
    build_event_slot_groups,
    valid_localizations,
)

# A ceiling, not a target: the list is as long as the good options are.
MAX_RECOMMENDATIONS = 10
# A window is listed only while it is at least this share of the best score.
RELATIVE_SCORE_FLOOR = 0.5
# Absorbs float noise in the floor test, so an exact half is always kept.
SCORE_EPSILON = 1e-9
# Stamped on every basis; a cached snapshot with another stamp is recomputed.
RECOMMENDATION_RULE_VERSION = 2


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


def _open_runs(group, blocked: frozenset[int]) -> list[tuple]:
    """Split a group's slots into the contiguous runs left between blocked slots.

    A blocked slot breaks a run exactly like the group boundary does, so no
    candidate window can ever span one.
    """

    runs = []
    current = []
    for slot in group.slots:
        if slot.index in blocked:
            if current:
                runs.append(tuple(current))
            current = []
            continue
        current.append(slot)
    if current:
        runs.append(tuple(current))
    return runs


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


def _recommendation(event, candidate) -> dict:
    """The published dict for one selected window (keys unchanged since v1)."""

    channel, group, slots, (starts_at, ends_at), weighted, unweighted, metric = candidate[1:]
    first_slot = slots[0]
    last_slot = slots[-1]
    return {
        "channel": channel,
        "slotIndex": first_slot.index,
        "endSlotIndex": last_slot.index,
        "slotIndices": [slot.index for slot in slots],
        "durationMinutes": _meeting_duration_minutes(event),
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
        "weightedAvailability": round(weighted, 4),
        "unweightedAvailability": round(unweighted, 4),
        "fullyAvailableParticipantTotal": metric["fullyAvailable"],
        "partiallyAvailableParticipantTotal": metric["partiallyAvailable"],
        "unavailableParticipantTotal": metric["unavailable"],
    }


def build_ranked_recommendations(
    event,
    *,
    classified: dict,
    channel_results: dict,
    now: datetime | None = None,
) -> tuple[list[dict], dict]:
    """Rank the meeting windows worth offering, best first.

    Every window of the meeting's length is scored per participant by their
    lowest availability inside it. The list then keeps only windows that
    (1) someone with a weight above 0 can attend for all of it, (2) score at
    least ``RELATIVE_SCORE_FLOOR`` of the best window, and (3) share no slot
    with a better listed window in the same channel, up to
    ``MAX_RECOMMENDATIONS``. So its length follows the data: one clear winner
    lists one window, and 0% windows never pad the list.
    """

    counted = classified["counted"]
    duration_minutes = _meeting_duration_minutes(event)
    duration_is_valid = (
        duration_minutes >= event.slot_minutes and duration_minutes % event.slot_minutes == 0
    )
    window_size = duration_minutes // event.slot_minutes if duration_is_valid else 0
    basis = {
        "ruleVersion": RECOMMENDATION_RULE_VERSION,
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
        "selection": [
            "someoneWhoCountsCanAttend",
            "atLeastHalfOfBest",
            "noSharedSlotWithinChannel",
            "maximumRecommendations",
        ],
        "relativeScoreFloor": RELATIVE_SCORE_FLOOR,
        "candidateTotal": 0,
        "viableWindowTotal": 0,
        "qualifyingWindowTotal": 0,
        "bestWeightedAvailability": None,
        "weightedAvailabilityFloor": None,
        "nextWeightedAvailability": None,
        "listEnd": None,
        "zeroWeightOnlyAvailability": False,
        "status": "waiting_for_submissions" if not counted else "ready",
    }
    if not counted:
        return [], basis
    if not duration_is_valid:
        basis["status"] = "invalid_duration"
        return [], basis

    current_time = now or timezone.now()
    blocked = blocked_slot_indices(event)
    open_runs = [
        (group, run)
        for group in build_event_slot_groups(event)
        for run in _open_runs(group, blocked)
    ]
    channel_positions = {
        channel: position for position, channel in enumerate(channel_results.keys())
    }
    counted_total = len(counted)
    total_weight = sum(entry["weight"] for entry in counted if entry["weight"] > 0)
    candidate_total = 0
    zero_weight_only = False
    viable = []

    for channel in channel_results:
        for group, run in open_runs:
            if len(run) < window_size:
                continue
            windows = [
                run[position : position + window_size]
                for position in range(len(run) - window_size + 1)
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
                    run,
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
                candidate_total += 1
                raw_weighted_score = metric["weightedTotal"] / total_weight if total_weight else 0.0
                raw_unweighted_score = metric["unweightedTotal"] / counted_total
                # Viable only when someone with a weight above 0 has a value
                # above 0 in every slot: a sum of non-negative terms is 0 only
                # when every term is. Weight-0 availability alone never counts.
                if raw_weighted_score <= 0:
                    zero_weight_only = zero_weight_only or raw_unweighted_score > 0
                    continue
                viable.append(
                    (
                        (
                            -raw_weighted_score,
                            -raw_unweighted_score,
                            -metric["fullyAvailable"],
                            slots[0].index,
                            channel_positions[channel],
                            position,
                        ),
                        channel,
                        group,
                        slots,
                        suggestion,
                        raw_weighted_score,
                        raw_unweighted_score,
                        metric,
                    )
                )

    basis["candidateTotal"] = candidate_total
    basis["viableWindowTotal"] = len(viable)
    if not candidate_total:
        basis["status"] = "no_future_slots"
        return [], basis
    if not total_weight:
        basis["status"] = "no_weighted_responses"
        return [], basis
    if not viable:
        basis["status"] = "no_viable_windows"
        basis["zeroWeightOnlyAvailability"] = zero_weight_only
        return [], basis

    # The sort key is a strict total order, so the list is deterministic.
    viable.sort(key=lambda candidate: candidate[0])
    best = viable[0][5]
    floor = RELATIVE_SCORE_FLOOR * best
    claimed = {channel: set() for channel in channel_results}
    selected = []
    qualifying = 0
    next_score = None
    for position, candidate in enumerate(viable):
        channel, slots, weighted = candidate[1], candidate[3], candidate[5]
        if weighted < floor - SCORE_EPSILON:
            # Everything from here on scores no higher; report the first one
            # that is a new time rather than a shift of a listed window.
            next_score = next(
                (
                    rest[5]
                    for rest in viable[position:]
                    if claimed[rest[1]].isdisjoint(slot.index for slot in rest[3])
                ),
                None,
            )
            break
        indices = {slot.index for slot in slots}
        # A window shifted by a slot or two from a better one is the same
        # option; only the same time in the other channel is a distinct one.
        if not claimed[channel].isdisjoint(indices):
            continue
        claimed[channel].update(indices)
        qualifying += 1
        if len(selected) < MAX_RECOMMENDATIONS:
            selected.append(candidate)

    recommendations = []
    for rank, candidate in enumerate(selected, start=1):
        recommendation = _recommendation(event, candidate)
        recommendation["rank"] = rank
        recommendations.append(recommendation)
    basis["qualifyingWindowTotal"] = qualifying
    basis["bestWeightedAvailability"] = round(best, 4)
    basis["weightedAvailabilityFloor"] = round(floor, 4)
    if next_score is not None:
        basis["nextWeightedAvailability"] = round(next_score, 4)
    if qualifying > len(selected):
        basis["listEnd"] = "limit"
    elif next_score is not None:
        basis["listEnd"] = "belowFloor"
    else:
        basis["listEnd"] = "noMoreWindows"
    return recommendations, basis
