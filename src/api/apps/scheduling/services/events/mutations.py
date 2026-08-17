"""Create, update, duplicate, and delete events."""

import hashlib
import json
import logging
import uuid
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import (
    Event,
    EventDeletionRecord,
    EventDuplicationRequest,
    EventInvitation,
    FinalMeeting,
    Participant,
    UserEvent,
)
from apps.scheduling.services.availability import default_availability
from apps.scheduling.services.results.snapshots import ensure_result_snapshot

from .codes import generate_event_code
from .configuration import (
    CONFIGURATION_FIELDS,
    GEOMETRY_FIELDS,
    RESULT_FIELDS,
    parse_event_configuration,
)
from .errors import EventManagementError
from .lifecycle import event_configuration_write_error
from .types import EventDeleteResult, EventDuplicateResult, EventUpdateResult

logger = logging.getLogger(__name__)


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
