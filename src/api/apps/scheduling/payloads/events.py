"""API payloads for events and their final meeting."""

from apps.scheduling.services.slots import api_slot_groups, event_slot_count, format_time_value


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
