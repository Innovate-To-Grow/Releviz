"""Attendance review for a proposed final meeting time."""

from apps.scheduling.models import Event
from apps.scheduling.services.results.aggregation import classify_event_responses


def build_attendance_review(event: Event, normalized: dict) -> dict:
    classified = classify_event_responses(event)
    channel = normalized["channel"]
    indices = normalized["slot_indices"]
    participants = []
    for entry in classified["counted"]:
        values = [entry["availability"][channel][index] for index in indices]
        if all(value >= 1 for value in values):
            status = "available"
        elif any(value > 0 for value in values):
            status = "partial"
        else:
            status = "unavailable"
        participants.append(
            {
                "participantId": str(entry["participant"].member_id),
                "name": entry["participant"].participant_name,
                "status": status,
                "minimumAvailability": min(values),
            }
        )

    unanswered = [
        {
            "participantId": str(entry["participant"].member_id),
            "name": entry["participant"].participant_name,
        }
        for entry in classified["unanswered"]
    ]
    excluded = [
        {
            "participantId": str(entry["participant"].member_id),
            "name": entry["participant"].participant_name,
            "reason": entry["reason"],
        }
        for entry in classified["excluded"]
    ]
    return {
        "channel": channel,
        "slotIndices": indices,
        "countedResponseTotal": len(participants),
        "availableParticipantTotal": sum(
            participant["status"] == "available" for participant in participants
        ),
        "partialParticipantTotal": sum(
            participant["status"] == "partial" for participant in participants
        ),
        "unavailableParticipantTotal": sum(
            participant["status"] == "unavailable" for participant in participants
        ),
        "unansweredParticipantTotal": len(unanswered),
        "excludedParticipantTotal": len(excluded),
        "participants": participants,
        "unansweredParticipants": unanswered,
        "excludedParticipants": excluded,
    }


def final_notification_recipients(event: Event) -> list[str]:
    active_member_ids = event.participants.filter(hidden=False).values_list(
        "member_id",
        flat=True,
    )
    recipients = event.invitations.filter(
        member_id__in=active_member_ids,
        first_sent_at__isnull=False,
    ).values_list("email", flat=True)
    return sorted({email.strip().lower() for email in recipients if email})
