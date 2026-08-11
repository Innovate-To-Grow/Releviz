import secrets
import string

from apps.scheduling.slots import (
    api_slot_groups,
    event_slot_count,
    format_time_value,
)

CODE_ALPHABET = string.ascii_uppercase + string.digits
_INVITATION_NOT_PROVIDED = object()


def generate_event_code(length: int = 8) -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))


def api_event(event, *, include_slot_groups=True) -> dict:
    final_meeting = getattr(event, "final_meeting", None)
    data = {
        "code": event.code,
        "name": event.name,
        "startTime": format_time_value(event.start_minutes),
        "endTime": format_time_value(event.end_minutes),
        "slotMinutes": event.slot_minutes,
        "slotCount": event_slot_count(event),
        "crossesMidnight": event.spans_next_day,
        "days": event.days,
        "mode": event.mode,
        "location": event.location,
        "organizerUserId": str(event.organizer_id),
        "participantViewPermission": event.participant_view_permission,
        "daySelectionType": event.day_selection_type,
        "responseDeadline": (
            event.response_deadline.isoformat() if event.response_deadline else None
        ),
        "timezone": event.timezone,
        "remindersEnabled": event.reminders_enabled,
        "reminderHoursBefore": event.reminder_hours_before,
        "accessMode": getattr(event, "access_mode", "invite_only"),
        "meetingDurationMinutes": getattr(event, "meeting_duration_minutes", event.slot_minutes),
        "resultsRevision": getattr(event, "results_revision", 1),
        "status": event.status,
        "version": event.version,
        "openedAt": event.opened_at.isoformat() if event.opened_at else None,
        "finalizedAt": event.finalized_at.isoformat() if event.finalized_at else None,
        "closedAt": event.closed_at.isoformat() if event.closed_at else None,
        "archivedAt": event.archived_at.isoformat() if event.archived_at else None,
        "createdAt": event.created_at.isoformat(),
        "finalMeeting": (
            api_final_meeting(final_meeting)
            if final_meeting is not None and final_meeting.active
            else None
        ),
    }
    if include_slot_groups:
        data["slotGroups"] = api_slot_groups(event)
    if event.specific_dates:
        data["specificDates"] = event.specific_dates
    return data


def api_final_meeting(final_meeting, *, include_attendance=False) -> dict:
    data = {
        "startsAt": final_meeting.starts_at.isoformat(),
        "endsAt": final_meeting.ends_at.isoformat(),
        "timezone": final_meeting.timezone,
        "channel": final_meeting.channel,
        "location": final_meeting.location,
        "calendarUid": final_meeting.calendar_uid,
        "calendarSequence": final_meeting.calendar_sequence,
        "confirmedAt": final_meeting.confirmed_at.isoformat(),
        "active": final_meeting.active,
    }
    if include_attendance:
        data["attendance"] = final_meeting.attendance_snapshot
    return data


def api_participant(
    participant,
    *,
    organizer_private=False,
    invitation=_INVITATION_NOT_PROVIDED,
) -> dict:
    data = {
        "id": str(participant.member_id),
        "user_id": str(participant.member_id),
        "event_id": str(participant.event.event_id),
        "name": participant.participant_name,
        "availabilityInperson": participant.availability_inperson,
        "availabilityVirtual": participant.availability_virtual,
        "submitted": 1 if participant.submitted else 0,
        "hidden": 1 if participant.hidden else 0,
        "group_name": participant.group_name,
        "sort_order": participant.sort_order,
        "version": participant.version,
        "created_at": participant.created_at.isoformat(),
    }
    if not organizer_private:
        return data

    member = participant.member
    member_email = str(member.email or "").strip().lower()
    if not member_email:
        member_email = member.get_primary_contact_email()
    if invitation is _INVITATION_NOT_PROVIDED:
        invitation = (
            participant.event.invitations.filter(member_id=participant.member_id)
            .order_by("-created_at")
            .first()
        )
        if invitation is None:
            if member_email:
                invitation = participant.event.invitations.filter(
                    email__iexact=member_email,
                ).first()

    private_email = (
        str(invitation.email or "").strip().lower() if invitation is not None else member_email
    )

    account_access = getattr(member, "access_level", "full")
    if participant.submitted or (invitation is not None and invitation.status == "submitted"):
        invitation_status = "submitted"
    elif invitation is None or invitation.first_sent_at is None:
        invitation_status = "not_sent"
    elif invitation.opened_at is not None or invitation.status in {
        "opened",
        "joined",
        "draft_saved",
    }:
        invitation_status = "opened"
    else:
        invitation_status = "invited"

    data.update(
        {
            "accountAccess": account_access,
            "email": private_email,
            "invitationStatus": invitation_status,
            "canOrganizerEditAvailability": account_access == "temporary",
        }
    )
    return data


def api_weight(weight) -> dict:
    return {
        "participant_id": str(weight.participant.member_id),
        "participant_name": weight.participant.participant_name,
        "weight": float(weight.weight),
        "included": 1 if weight.included else 0,
    }


def expected_availability_length(event) -> int:
    return event_slot_count(event)


def default_availability(event) -> list[int]:
    return [0] * expected_availability_length(event)


def validate_availability(availability, event, label: str):
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
