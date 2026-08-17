from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import date, timedelta

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.lifecycle import event_configuration_write_error
from apps.scheduling.models import (
    Event,
    EventDeletionRecord,
    EventDuplicationRequest,
    EventInvitation,
    FinalMeeting,
    Participant,
    UserEvent,
)
from apps.scheduling.result_snapshots import ensure_result_snapshot
from apps.scheduling.slots import (
    MAX_SPECIFIC_DATES,
    SlotConfigurationError,
    build_event_slot_groups,
    format_time_value,
    parse_time_value,
)
from apps.scheduling.utils import default_availability, generate_event_code
from apps.scheduling.validators import validate_iana_timezone

logger = logging.getLogger(__name__)

CONFIGURATION_FIELDS = (
    "name",
    "start_minutes",
    "end_minutes",
    "slot_minutes",
    "spans_next_day",
    "days",
    "mode",
    "location",
    "participant_view_permission",
    "day_selection_type",
    "specific_dates",
    "response_deadline",
    "timezone",
    "reminders_enabled",
    "reminder_hours_before",
    "access_mode",
    "meeting_duration_minutes",
)
GEOMETRY_FIELDS = {
    "start_minutes",
    "end_minutes",
    "slot_minutes",
    "spans_next_day",
    "days",
    "day_selection_type",
    "specific_dates",
    "timezone",
}
RESULT_FIELDS = GEOMETRY_FIELDS | {
    "mode",
    "meeting_duration_minutes",
}


class EventManagementError(ValueError):
    def __init__(self, message, *, status_code=400, event=None, extra=None):
        super().__init__(message)
        self.status_code = status_code
        self.event = event
        self.extra = extra or {}


@dataclass(frozen=True)
class EventUpdateResult:
    event: Event
    responses_reset: int
    idempotent: bool


@dataclass(frozen=True)
class EventDuplicateResult:
    event: Event
    idempotent: bool


@dataclass(frozen=True)
class EventDeleteResult:
    code: str
    idempotent: bool


def _value(data, key, existing, attribute, default):
    if key in data:
        return data.get(key)
    if existing is not None:
        return getattr(existing, attribute)
    return default


def parse_event_configuration(data, *, existing=None) -> dict:
    name = str(_value(data, "name", existing, "name", "") or "").strip()
    if not name:
        raise EventManagementError("Name is required")
    if len(name) > 200:
        raise EventManagementError("Event name too long (max 200)")

    if "startHour" in data or "endHour" in data:
        raise EventManagementError("Use startTime and endTime in HH:MM format.")
    raw_start = (
        data.get("startTime")
        if "startTime" in data
        else format_time_value(existing.start_minutes)
        if existing is not None
        else "09:00"
    )
    raw_end = (
        data.get("endTime")
        if "endTime" in data
        else format_time_value(existing.end_minutes)
        if existing is not None
        else "17:00"
    )
    try:
        start_minutes = parse_time_value(raw_start, "startTime")
        end_minutes = parse_time_value(raw_end, "endTime")
    except SlotConfigurationError as exc:
        raise EventManagementError(str(exc)) from exc
    if start_minutes == end_minutes:
        raise EventManagementError("Event start and end times must be different.")
    spans_next_day = end_minutes < start_minutes

    slot_minutes = _value(data, "slotMinutes", existing, "slot_minutes", 30)
    if (
        isinstance(slot_minutes, bool)
        or not isinstance(slot_minutes, int)
        or slot_minutes not in {15, 30}
    ):
        raise EventManagementError("slotMinutes must be 15 or 30.")

    mode = str(_value(data, "mode", existing, "mode", "inperson") or "inperson")
    if mode not in {"virtual", "inperson", "mixed"}:
        raise EventManagementError("Invalid mode. Must be 'inperson', 'virtual', or 'mixed'")
    raw_location = _value(data, "location", existing, "location", "")
    location = "" if mode == "virtual" else (str(raw_location or "").strip() or "TBD")
    if len(location) > 500:
        raise EventManagementError("Location too long (max 500)")

    day_selection_type = str(
        _value(data, "daySelectionType", existing, "day_selection_type", "days_of_week")
        or "days_of_week"
    )
    if day_selection_type not in {"days_of_week", "specific_dates"}:
        raise EventManagementError("Invalid daySelectionType")
    if day_selection_type == "specific_dates":
        if "specificDates" in data:
            specific_dates = data.get("specificDates")
        elif existing is not None and existing.day_selection_type == "specific_dates":
            specific_dates = existing.specific_dates
        else:
            specific_dates = None
        if not isinstance(specific_dates, list) or not specific_dates:
            raise EventManagementError("specificDates must be a non-empty array")
        if len(specific_dates) > MAX_SPECIFIC_DATES:
            raise EventManagementError(
                f"specificDates may contain at most {MAX_SPECIFIC_DATES} dates"
            )
        parsed_dates = []
        try:
            for item in specific_dates:
                parsed = date.fromisoformat(item)
                if parsed.isoformat() != item:
                    raise ValueError
                parsed_dates.append(item)
        except (TypeError, ValueError) as exc:
            raise EventManagementError(
                "specificDates must be ISO date strings (YYYY-MM-DD)"
            ) from exc
        if len(set(parsed_dates)) != len(parsed_dates):
            raise EventManagementError("specificDates must not contain duplicates")
        specific_dates = sorted(parsed_dates)
        selected_days = []
    else:
        specific_dates = None
        if "days" in data:
            selected_days = data.get("days")
        elif existing is not None and existing.day_selection_type == "days_of_week":
            selected_days = existing.days
        else:
            selected_days = [1, 2, 3, 4, 5]
        if (
            not isinstance(selected_days, list)
            or not selected_days
            or any(
                isinstance(day, bool) or not isinstance(day, int) or day < 0 or day > 6
                for day in selected_days
            )
        ):
            raise EventManagementError("days must be a non-empty array of integers 0-6")
        selected_days = sorted(set(selected_days))

    view_permission = str(
        _value(
            data,
            "participantViewPermission",
            existing,
            "participant_view_permission",
            "own_only",
        )
        or "own_only"
    )
    if view_permission == "all":
        view_permission = "all_after_submit"
    if view_permission not in {"own_only", "all_after_submit", "realtime"}:
        raise EventManagementError("Invalid participantViewPermission value")

    event_timezone = str(_value(data, "timezone", existing, "timezone", "UTC") or "").strip()
    try:
        validate_iana_timezone(event_timezone)
    except ValidationError as exc:
        raise EventManagementError("timezone must be a valid IANA timezone") from exc

    if "responseDeadline" in data:
        raw_deadline = data.get("responseDeadline")
        if raw_deadline:
            response_deadline = parse_datetime(str(raw_deadline))
            if response_deadline is None:
                raise EventManagementError("responseDeadline must be an ISO datetime")
            if timezone.is_naive(response_deadline):
                response_deadline = timezone.make_aware(response_deadline)
        else:
            response_deadline = None
    else:
        response_deadline = existing.response_deadline if existing is not None else None

    reminders_enabled = _value(
        data,
        "remindersEnabled",
        existing,
        "reminders_enabled",
        True,
    )
    if not isinstance(reminders_enabled, bool):
        raise EventManagementError("remindersEnabled must be a boolean")
    reminder_hours_before = _value(
        data,
        "reminderHoursBefore",
        existing,
        "reminder_hours_before",
        24,
    )
    if isinstance(reminder_hours_before, bool):
        raise EventManagementError("reminderHoursBefore must be an integer")
    try:
        reminder_hours_before = int(reminder_hours_before)
    except (TypeError, ValueError) as exc:
        raise EventManagementError("reminderHoursBefore must be an integer") from exc
    if reminder_hours_before < 0 or reminder_hours_before > 720:
        raise EventManagementError("reminderHoursBefore must be between 0 and 720")

    access_mode = str(
        _value(data, "accessMode", existing, "access_mode", "invite_only") or "invite_only"
    )
    if access_mode not in {"invite_only", "open_link"}:
        raise EventManagementError("accessMode must be 'invite_only' or 'open_link'")

    meeting_duration_minutes = _value(
        data,
        "meetingDurationMinutes",
        existing,
        "meeting_duration_minutes",
        30,
    )
    if isinstance(meeting_duration_minutes, bool):
        raise EventManagementError("meetingDurationMinutes must be an integer")
    try:
        meeting_duration_minutes = int(meeting_duration_minutes)
    except (TypeError, ValueError) as exc:
        raise EventManagementError("meetingDurationMinutes must be an integer") from exc
    if meeting_duration_minutes < 15 or meeting_duration_minutes > 480:
        raise EventManagementError("meetingDurationMinutes must be between 15 and 480")
    if meeting_duration_minutes % slot_minutes:
        raise EventManagementError("meetingDurationMinutes must be a multiple of slotMinutes")

    candidate = Event(
        start_minutes=start_minutes,
        end_minutes=end_minutes,
        slot_minutes=slot_minutes,
        spans_next_day=spans_next_day,
        days=selected_days,
        day_selection_type=day_selection_type,
        specific_dates=specific_dates,
        timezone=event_timezone,
    )
    try:
        slot_groups = build_event_slot_groups(candidate)
    except SlotConfigurationError as exc:
        raise EventManagementError(str(exc)) from exc
    required_slots = meeting_duration_minutes // slot_minutes
    if not any(len(group.slots) >= required_slots for group in slot_groups):
        raise EventManagementError("meetingDurationMinutes does not fit within any configured day")

    return {
        "name": name,
        "start_minutes": start_minutes,
        "end_minutes": end_minutes,
        "slot_minutes": slot_minutes,
        "spans_next_day": spans_next_day,
        "days": selected_days,
        "mode": mode,
        "location": location,
        "participant_view_permission": view_permission,
        "day_selection_type": day_selection_type,
        "specific_dates": specific_dates,
        "response_deadline": response_deadline,
        "timezone": event_timezone,
        "reminders_enabled": reminders_enabled,
        "reminder_hours_before": reminder_hours_before,
        "access_mode": access_mode,
        "meeting_duration_minutes": meeting_duration_minutes,
    }


def _require_expected_version(data) -> int:
    expected_version = data.get("expectedVersion")
    if isinstance(expected_version, bool) or not isinstance(expected_version, int):
        raise EventManagementError("expectedVersion is required", status_code=428)
    return expected_version


def _require_idempotency_key(data) -> uuid.UUID:
    raw_key = data.get("idempotencyKey")
    try:
        return uuid.UUID(str(raw_key))
    except (TypeError, ValueError, AttributeError) as exc:
        raise EventManagementError("idempotencyKey must be a UUID") from exc


def _fingerprint(payload) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _unique_event_code() -> str:
    for _attempt in range(3):
        code = generate_event_code()
        if Event.objects.filter(code=code).exists():
            continue
        if EventDeletionRecord.objects.filter(code=code).exists():
            continue
        return code
    raise EventManagementError("Failed to generate unique code", status_code=500)


def _insert_event(*, organizer, configuration, status, now) -> Event:
    for _attempt in range(3):
        code = _unique_event_code()
        try:
            with transaction.atomic():
                event = Event.objects.create(
                    code=code,
                    organizer=organizer,
                    status=status,
                    opened_at=now if status == Event.Status.ACTIVE else None,
                    **configuration,
                )
                ensure_result_snapshot(event)
                return event
        except IntegrityError:
            continue
    raise EventManagementError("Failed to generate unique code", status_code=500)


@transaction.atomic
def create_event(*, organizer, data) -> Event:
    configuration = parse_event_configuration(data)
    initial_status = data.get("status", Event.Status.ACTIVE)
    if initial_status != Event.Status.ACTIVE:
        raise EventManagementError("New events must start as active.")
    current_time = timezone.now()
    if (
        configuration["response_deadline"] is not None
        and current_time >= configuration["response_deadline"]
    ):
        raise EventManagementError("An active event must have a future response deadline")
    event = _insert_event(
        organizer=organizer,
        configuration=configuration,
        status=initial_status,
        now=current_time,
    )
    UserEvent.objects.create(member=organizer, event=event, role="organizer")
    return event


def _changed_configuration_fields(event, configuration) -> list[str]:
    return [
        field for field in CONFIGURATION_FIELDS if getattr(event, field) != configuration[field]
    ]


@transaction.atomic
def update_event(*, organizer, code, data) -> EventUpdateResult:
    event = Event.objects.select_for_update().filter(code=code).first()
    if event is None:
        raise EventManagementError("Event not found", status_code=404)
    if event.organizer_id != organizer.pk:
        raise EventManagementError(
            "Only the organizer can edit this event",
            status_code=403,
        )

    expected_version = _require_expected_version(data)
    reset_responses = data.get("resetResponses", False)
    if not isinstance(reset_responses, bool):
        raise EventManagementError("resetResponses must be a boolean")
    configuration = parse_event_configuration(data, existing=event)
    changed_fields = _changed_configuration_fields(event, configuration)

    if event.version != expected_version:
        if not changed_fields:
            return EventUpdateResult(event=event, responses_reset=0, idempotent=True)
        raise EventManagementError(
            "The event changed in another session. Reload it and review your edits.",
            status_code=409,
            event=event,
        )
    if not changed_fields:
        return EventUpdateResult(event=event, responses_reset=0, idempotent=True)

    write_error = event_configuration_write_error(event)
    if write_error:
        raise EventManagementError(write_error)
    if FinalMeeting.objects.filter(event=event, active=True).exists():
        raise EventManagementError(
            "Reopen the event before editing settings for a confirmed meeting."
        )
    if (
        "response_deadline" in changed_fields
        and event.status == Event.Status.ACTIVE
        and configuration["response_deadline"] is not None
        and timezone.now() >= configuration["response_deadline"]
    ):
        raise EventManagementError("An active event must have a future response deadline")

    geometry_changed = bool(GEOMETRY_FIELDS.intersection(changed_fields))
    participants = list(event.participants.select_for_update().all()) if geometry_changed else []
    if participants and not reset_responses:
        raise EventManagementError(
            "These schedule changes would invalidate saved availability. "
            "Confirm that participant responses may be reset.",
            status_code=409,
            event=event,
            extra={
                "requiresResponseReset": True,
                "participantCount": len(participants),
            },
        )

    for field in changed_fields:
        setattr(event, field, configuration[field])
    event.version += 1
    update_fields = [*changed_fields, "version", "updated_at"]
    if RESULT_FIELDS.intersection(changed_fields):
        event.results_revision += 1
        update_fields.append("results_revision")
    event.save(update_fields=update_fields)
    if RESULT_FIELDS.intersection(changed_fields):
        ensure_result_snapshot(event)

    responses_reset = 0
    if participants:
        current_time = timezone.now()
        replacement = default_availability(event)
        for participant in participants:
            participant.availability_inperson = list(replacement)
            participant.availability_virtual = list(replacement)
            participant.submitted = False
            participant.version += 1
            participant.updated_at = current_time
        Participant.objects.bulk_update(
            participants,
            [
                "availability_inperson",
                "availability_virtual",
                "submitted",
                "version",
                "updated_at",
            ],
        )
        EventInvitation.objects.filter(
            event=event,
            status=EventInvitation.Status.SUBMITTED,
        ).update(
            status=EventInvitation.Status.JOINED,
            updated_at=current_time,
        )
        responses_reset = len(participants)

    return EventUpdateResult(
        event=event,
        responses_reset=responses_reset,
        idempotent=False,
    )


def _copy_name(source_name: str) -> str:
    suffix = " (copy)"
    return f"{source_name[: 200 - len(suffix)]}{suffix}"


@transaction.atomic
def duplicate_event(*, organizer, code, data) -> EventDuplicateResult:
    source = Event.objects.select_for_update().filter(code=code).first()
    if source is None:
        raise EventManagementError("Event not found", status_code=404)
    if source.organizer_id != organizer.pk:
        raise EventManagementError(
            "Only the organizer can duplicate this event",
            status_code=403,
        )

    expected_version = _require_expected_version(data)
    idempotency_key = _require_idempotency_key(data)
    requested_name = data.get("name")
    if requested_name is not None:
        requested_name = str(requested_name).strip()
        if not requested_name:
            raise EventManagementError("Duplicate event name cannot be empty")
        if len(requested_name) > 200:
            raise EventManagementError("Event name too long (max 200)")
    request_fingerprint = _fingerprint(
        {
            "expectedVersion": expected_version,
            "name": requested_name,
        }
    )

    existing_request = (
        EventDuplicationRequest.objects.select_related("duplicate_event")
        .filter(source_event=source, idempotency_key=idempotency_key)
        .first()
    )
    if existing_request is not None:
        if existing_request.request_fingerprint != request_fingerprint:
            raise EventManagementError(
                "This duplication key was already used with different details.",
                status_code=409,
            )
        if existing_request.duplicate_event is None:
            raise EventManagementError(
                "The event created by this duplication request has been deleted.",
                status_code=410,
            )
        return EventDuplicateResult(
            event=existing_request.duplicate_event,
            idempotent=True,
        )

    if source.version != expected_version:
        raise EventManagementError(
            "The event changed in another session. Reload it before duplicating.",
            status_code=409,
            event=source,
        )

    configuration = {field: getattr(source, field) for field in CONFIGURATION_FIELDS}
    configuration["name"] = requested_name or _copy_name(source.name)
    current_time = timezone.now()
    if (
        configuration["response_deadline"] is not None
        and configuration["response_deadline"] <= current_time
    ):
        configuration["response_deadline"] = None
    duplicate = _insert_event(
        organizer=organizer,
        configuration=configuration,
        status=Event.Status.ACTIVE,
        now=current_time,
    )
    UserEvent.objects.create(member=organizer, event=duplicate, role="organizer")
    EventDuplicationRequest.objects.create(
        source_event=source,
        duplicate_event=duplicate,
        requested_by=organizer,
        idempotency_key=idempotency_key,
        request_fingerprint=request_fingerprint,
        source_version=source.version,
    )
    return EventDuplicateResult(event=duplicate, idempotent=False)


@transaction.atomic
def delete_event(*, organizer, code, data) -> EventDeleteResult:
    expected_version = _require_expected_version(data)
    idempotency_key = _require_idempotency_key(data)
    confirmation = data.get("confirmation")
    request_fingerprint = _fingerprint(
        {
            "code": code,
            "expectedVersion": expected_version,
            "confirmation": confirmation,
        }
    )

    event = Event.objects.select_for_update().filter(code=code).first()
    if event is None:
        record = EventDeletionRecord.objects.filter(code=code).first()
        if (
            record is not None
            and record.organizer_id == organizer.pk
            and record.idempotency_key == idempotency_key
            and record.request_fingerprint == request_fingerprint
        ):
            return EventDeleteResult(code=code, idempotent=True)
        raise EventManagementError("Event not found", status_code=404)
    if event.organizer_id != organizer.pk:
        raise EventManagementError(
            "Only the organizer can delete this event",
            status_code=403,
        )
    if confirmation != event.code:
        raise EventManagementError("Type the event code exactly to confirm deletion")
    if event.version != expected_version:
        raise EventManagementError(
            "The event changed in another session. Reload it before deleting.",
            status_code=409,
            event=event,
        )
    if EventDeletionRecord.objects.filter(
        organizer=organizer,
        idempotency_key=idempotency_key,
    ).exists():
        raise EventManagementError(
            "This deletion key was already used for another event.",
            status_code=409,
        )

    jobs = list(event.email_delivery_jobs.select_for_update().all())
    stale_before = timezone.now() - timedelta(minutes=15)
    active_jobs = [
        job
        for job in jobs
        if job.status == EmailDeliveryJob.Status.PROCESSING
        and job.locked_at is not None
        and job.locked_at > stale_before
    ]
    if active_jobs:
        raise EventManagementError(
            "Email delivery is currently in progress. Try deleting again shortly.",
            status_code=409,
            extra={"retryable": True},
        )

    event_id = event.event_id
    deleted_version = event.version
    EventDeletionRecord.objects.create(
        event_id=event_id,
        code=event.code,
        organizer=organizer,
        idempotency_key=idempotency_key,
        request_fingerprint=request_fingerprint,
        deleted_version=deleted_version,
    )
    EmailMessageLog.objects.filter(
        Q(event=event) | Q(invitation__event=event) | Q(delivery_job__event=event)
    ).delete()
    event.delete()
    transaction.on_commit(
        lambda: logger.info(
            "event_deleted",
            extra={
                "event_id": str(event_id),
                "event_code": code,
                "organizer_id": str(organizer.pk),
                "deleted_version": deleted_version,
            },
        )
    )
    return EventDeleteResult(code=code, idempotent=False)
