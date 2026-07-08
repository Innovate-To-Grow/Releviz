import json
import secrets
import string

DAYS_PER_WEEK = 7
CODE_ALPHABET = string.ascii_uppercase + string.digits


def generate_event_code(length: int = 8) -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))


def api_event(event) -> dict:
    data = {
        "code": event.code,
        "name": event.name,
        "startHour": event.start_hour,
        "endHour": event.end_hour,
        "days": event.days or [1, 2, 3, 4, 5],
        "mode": event.mode,
        "location": event.location,
        "organizerUserId": str(event.organizer_id),
        "participantViewPermission": event.participant_view_permission,
        "daySelectionType": event.day_selection_type,
        "createdAt": event.created_at.isoformat(),
    }
    if event.specific_dates:
        data["specificDates"] = event.specific_dates
    return data


def api_participant(participant) -> dict:
    return {
        "id": str(participant.member_id),
        "user_id": str(participant.member_id),
        "event_id": str(participant.event.event_id),
        "name": participant.participant_name,
        "schedule_inperson": participant.schedule_inperson,
        "schedule_virtual": participant.schedule_virtual,
        "submitted": 1 if participant.submitted else 0,
        "hidden": 1 if participant.hidden else 0,
        "group_name": participant.group_name,
        "sort_order": participant.sort_order,
        "created_at": participant.created_at.isoformat(),
    }


def api_weight(weight) -> dict:
    return {
        "participant_id": str(weight.participant.member_id),
        "participant_name": weight.participant.participant_name,
        "weight": float(weight.weight),
        "included": 1 if weight.included else 0,
    }


def expected_schedule_length(event) -> int:
    num_days = (
        len(event.specific_dates)
        if event.day_selection_type == "specific_dates" and isinstance(event.specific_dates, list)
        else DAYS_PER_WEEK
    )
    return (event.end_hour - event.start_hour) * num_days


def default_schedule(event) -> str:
    return json.dumps([0] * expected_schedule_length(event))


def validate_schedule(schedule, event, label: str):
    parsed = schedule
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except json.JSONDecodeError:
            return f"Invalid {label}: not valid JSON"
    if not isinstance(parsed, list):
        return f"Invalid {label}: must be an array"
    expected = expected_schedule_length(event)
    if len(parsed) != expected:
        return f"Invalid {label}: expected {expected} slots, got {len(parsed)}"
    if not all(isinstance(value, int | float) and 0 <= value <= 1 for value in parsed):
        return f"Invalid {label}: values must be numbers between 0 and 1"
    return None


def schedule_to_storage(schedule) -> str:
    if isinstance(schedule, list):
        return json.dumps(schedule)
    return schedule
