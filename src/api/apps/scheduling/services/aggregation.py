from __future__ import annotations

from apps.scheduling.services.recommendations import build_ranked_recommendations
from apps.scheduling.services.slots import expected_availability_length


def result_channels(event) -> tuple[str, ...]:
    if event.mode == "inperson":
        return ("inperson",)
    if event.mode == "virtual":
        return ("virtual",)
    return ("inperson", "virtual")


def parse_availability(value, expected_length: int) -> list[float] | None:
    if not isinstance(value, list) or len(value) != expected_length:
        return None
    if any(
        isinstance(item, bool) or not isinstance(item, int | float) or item < 0 or item > 1
        for item in value
    ):
        return None
    return [float(item) for item in value]


def participant_availability(participant, event) -> dict[str, list[float]] | None:
    expected_length = expected_availability_length(event)
    availability: dict[str, list[float]] = {}
    for channel in result_channels(event):
        parsed = parse_availability(
            getattr(participant, f"availability_{channel}"),
            expected_length,
        )
        if parsed is None:
            return None
        availability[channel] = parsed
    return availability


def participant_has_valid_submission(participant, event) -> bool:
    return bool(participant.submitted and participant_availability(participant, event) is not None)


def participant_is_excluded(participant, weight=None) -> bool:
    return bool(participant.hidden or (weight is not None and not weight.included))


def classify_event_responses(event) -> dict:
    participants = list(event.participants.select_related("member").all())
    weights = {
        weight.participant_id: weight
        for weight in event.weights.select_related("participant").all()
    }
    counted = []
    unanswered = []
    excluded = []

    for participant in participants:
        weight = weights.get(participant.pk)
        if participant.hidden:
            excluded.append(
                {
                    "participant": participant,
                    "reason": "hidden",
                }
            )
            continue
        if weight is not None and not weight.included:
            excluded.append(
                {
                    "participant": participant,
                    "reason": "organizerExcluded",
                }
            )
            continue
        if not participant.submitted:
            unanswered.append(
                {
                    "participant": participant,
                }
            )
            continue
        availability = participant_availability(participant, event)
        if availability is None:
            excluded.append(
                {
                    "participant": participant,
                    "reason": "invalidResponse",
                }
            )
            continue
        counted.append(
            {
                "participant": participant,
                "availability": availability,
                "weight": float(weight.weight) if weight is not None else 1.0,
            }
        )

    return {
        "counted": counted,
        "unanswered": unanswered,
        "excluded": excluded,
    }


def build_event_results(event, *, now=None) -> dict:
    classified = classify_event_responses(event)
    counted = classified["counted"]
    unanswered = classified["unanswered"]
    excluded = classified["excluded"]
    channels = result_channels(event)
    slot_count = expected_availability_length(event)
    excluded_reasons = {
        reason: sum(1 for entry in excluded if entry["reason"] == reason)
        for reason in ("hidden", "organizerExcluded", "invalidResponse")
    }

    unweighted_totals = {channel: [0.0] * slot_count for channel in channels}
    weighted_totals = {channel: [0.0] * slot_count for channel in channels}
    total_weight = 0.0
    weighted_participant_total = 0

    for entry in counted:
        availability = entry["availability"]
        weight_value = entry["weight"]
        if weight_value > 0:
            total_weight += weight_value
            weighted_participant_total += 1
        for channel in channels:
            for index, value in enumerate(availability[channel]):
                unweighted_totals[channel][index] += value
                if weight_value > 0:
                    weighted_totals[channel][index] += value * weight_value

    counted_total = len(counted)
    channel_results = {}
    for channel in channels:
        channel_results[channel] = {
            "unweighted": [
                round(value / counted_total, 4) if counted_total else 0.0
                for value in unweighted_totals[channel]
            ],
            "weighted": [
                round(value / total_weight, 4) if total_weight else 0.0
                for value in weighted_totals[channel]
            ],
        }

    recommendations, recommendation_basis = build_ranked_recommendations(
        event,
        classified=classified,
        channel_results=channel_results,
        now=now,
    )

    return {
        "eventCode": event.code,
        "slotCount": slot_count,
        "countedResponseTotal": counted_total,
        "unansweredParticipantTotal": len(unanswered),
        "excludedParticipantTotal": sum(excluded_reasons.values()),
        "exclusionReasons": excluded_reasons,
        "calculationBasis": {
            "unweighted": {"participantTotal": counted_total},
            "weighted": {
                "participantTotal": weighted_participant_total,
                "totalWeight": round(total_weight, 4),
            },
        },
        "channels": channel_results,
        "recommendations": recommendations,
        "recommendationBasis": recommendation_basis,
    }
