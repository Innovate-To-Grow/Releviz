from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

from apps.scheduling.slots import build_event_slot_groups, valid_localizations

MAX_RECOMMENDATIONS = 10


def _as_utc(value: datetime) -> datetime:
    if timezone.is_naive(value):
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _weekly_suggestion(event, group, slot, current_time: datetime):
    zone = ZoneInfo(event.timezone)
    current_time = _as_utc(current_time)
    local_today = current_time.astimezone(zone).date()

    for day_offset in range(15):
        base_date = local_today + timedelta(days=day_offset)
        weekday = (base_date.weekday() + 1) % 7
        if weekday != group.weekday:
            continue

        start_date = base_date + timedelta(days=slot.start_day_offset)
        end_date = base_date + timedelta(days=slot.end_day_offset)
        start_naive = datetime.combine(start_date, time.fromisoformat(slot.local_start))
        end_naive = datetime.combine(end_date, time.fromisoformat(slot.local_end))
        starts = valid_localizations(start_naive, zone)
        ends = valid_localizations(end_naive, zone)
        if len(starts) != 1 or len(ends) != 1:
            continue
        starts_at = starts[0].astimezone(UTC)
        ends_at = ends[0].astimezone(UTC)
        if starts_at >= current_time and ends_at > starts_at:
            return starts_at, ends_at
    return None


def _slot_suggestion(event, group, slot, current_time: datetime):
    if slot.starts_at is not None and slot.ends_at is not None:
        starts_at = slot.starts_at.astimezone(UTC)
        if starts_at < _as_utc(current_time):
            return None
        return starts_at, slot.ends_at.astimezone(UTC)
    return _weekly_suggestion(event, group, slot, current_time)


def _slot_label(group, slot) -> str:
    start_suffix = f" +{slot.start_day_offset}d" if slot.start_day_offset else ""
    end_suffix = f" +{slot.end_day_offset}d" if slot.end_day_offset else ""
    return f"{group.label} {slot.local_start}{start_suffix}–{slot.local_end}{end_suffix}"


def build_ranked_recommendations(
    event,
    *,
    classified: dict,
    channel_results: dict,
    now: datetime | None = None,
) -> tuple[list[dict], dict]:
    counted = classified["counted"]
    unanswered_required = sum(int(entry["required"]) for entry in classified["unanswered"])
    excluded_required = sum(int(entry["required"]) for entry in classified["excluded"])
    basis = {
        "candidateDurationMinutes": event.slot_minutes,
        "maximumRecommendations": MAX_RECOMMENDATIONS,
        "usesSubmittedResponsesOnly": True,
        "order": [
            "fewestRequiredParticipantConflicts",
            "highestWeightedAvailability",
            "highestUnweightedAvailability",
            "mostFullyAvailableParticipants",
            "earliestConfiguredSlot",
        ],
        "unansweredRequiredParticipantTotal": unanswered_required,
        "excludedRequiredParticipantTotal": excluded_required,
        "status": "waiting_for_submissions" if not counted else "ready",
    }
    if not counted:
        return [], basis

    current_time = now or timezone.now()
    groups = build_event_slot_groups(event)
    channel_positions = {
        channel: position for position, channel in enumerate(channel_results.keys())
    }
    candidates = []

    for channel, scores in channel_results.items():
        for group in groups:
            for slot in group.slots:
                suggestion = _slot_suggestion(event, group, slot, current_time)
                if suggestion is None:
                    continue
                starts_at, ends_at = suggestion
                values = [entry["availability"][channel][slot.index] for entry in counted]
                slot_required_conflicts = sum(
                    entry["required"] and value <= 0
                    for entry, value in zip(counted, values, strict=True)
                )
                fully_available = sum(value >= 1 for value in values)
                partially_available = sum(0 < value < 1 for value in values)
                unavailable = sum(value <= 0 for value in values)
                required_conflicts = (
                    slot_required_conflicts + unanswered_required + excluded_required
                )
                weighted_score = scores["weighted"][slot.index]
                unweighted_score = scores["unweighted"][slot.index]
                candidates.append(
                    {
                        "channel": channel,
                        "slotIndex": slot.index,
                        "groupKey": group.key,
                        "groupLabel": group.label,
                        "weekday": group.weekday,
                        "date": group.date_value,
                        "localStart": slot.local_start,
                        "localEnd": slot.local_end,
                        "startDayOffset": slot.start_day_offset,
                        "endDayOffset": slot.end_day_offset,
                        "suggestedStartsAt": starts_at.isoformat(),
                        "suggestedEndsAt": ends_at.isoformat(),
                        "label": _slot_label(group, slot),
                        "weightedAvailability": weighted_score,
                        "unweightedAvailability": unweighted_score,
                        "fullyAvailableParticipantTotal": fully_available,
                        "partiallyAvailableParticipantTotal": partially_available,
                        "unavailableParticipantTotal": unavailable,
                        "requiredParticipantConflictTotal": required_conflicts,
                        "_sort": (
                            required_conflicts,
                            -weighted_score,
                            -unweighted_score,
                            -fully_available,
                            channel_positions[channel],
                            slot.index,
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
