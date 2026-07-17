import secrets
import string

from apps.scheduling.slots import (
    api_slot_groups,
    event_slot_count,
    format_time_value,
)

CODE_ALPHABET = string.ascii_uppercase + string.digits


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


def api_participant(participant) -> dict:
    return {
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


def api_weight(weight) -> dict:
    return {
        "participant_id": str(weight.participant.member_id),
        "participant_name": weight.participant.participant_name,
        "weight": float(weight.weight),
        "included": 1 if weight.included else 0,
        "required": 1 if weight.required else 0,
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
