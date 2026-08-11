from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.mail.services import enqueue_email_job
from apps.scheduling.aggregation import classify_event_responses
from apps.scheduling.models import Event, FinalizationRequest, FinalMeeting
from apps.scheduling.services import (
    final_cancellation_body,
    final_cancellation_html_body,
    final_confirmation_body,
    final_confirmation_html_body,
    final_meeting_ics,
)
from apps.scheduling.slots import (
    SlotConfigurationError,
    build_event_slot_groups,
    event_window_duration_minutes,
    valid_localizations,
)


class FinalizationError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _matching_absolute_slot_indices(
    event: Event,
    starts_at: datetime,
    ends_at: datetime,
) -> list[int]:
    try:
        groups = build_event_slot_groups(event)
    except SlotConfigurationError as exc:
        raise FinalizationError(str(exc)) from exc

    for group in groups:
        if not group.slots:
            continue
        if starts_at < group.slots[0].starts_at or ends_at > group.slots[-1].ends_at:
            continue
        selected = [
            slot for slot in group.slots if slot.starts_at >= starts_at and slot.ends_at <= ends_at
        ]
        if (
            selected
            and selected[0].starts_at == starts_at
            and selected[-1].ends_at == ends_at
            and all(
                current.ends_at == following.starts_at
                for current, following in zip(selected, selected[1:], strict=False)
            )
        ):
            return [slot.index for slot in selected]

    raise FinalizationError(
        f"The final meeting must match one or more complete "
        f"{event.slot_minutes}-minute slots on a configured event date."
    )


def _weekly_slot_indices(
    event: Event,
    starts_at: datetime,
    ends_at: datetime,
    zone: ZoneInfo,
) -> list[int]:
    start_local = starts_at.astimezone(zone)
    selected_days = sorted(set(event.days or []))
    duration = event_window_duration_minutes(event)
    slots_per_group = duration // event.slot_minutes
    base_dates = [start_local.date()]
    if event.spans_next_day:
        base_dates.append(start_local.date() - timedelta(days=1))

    dst_error = None
    enabled_candidate = False
    for base_date in base_dates:
        weekday = (base_date.weekday() + 1) % 7
        if weekday not in selected_days:
            continue
        enabled_candidate = True
        base_midnight = datetime.combine(base_date, datetime.min.time())
        start_naive = starts_at.astimezone(zone).replace(tzinfo=None)
        end_naive = ends_at.astimezone(zone).replace(tzinfo=None)
        start_from_midnight = int((start_naive - base_midnight).total_seconds() // 60)
        end_from_midnight = int((end_naive - base_midnight).total_seconds() // 60)
        relative_start = start_from_midnight - event.start_minutes
        relative_end = end_from_midnight - event.start_minutes
        if (
            relative_start < 0
            or relative_end > duration
            or relative_end <= relative_start
            or relative_start % event.slot_minutes
            or relative_end % event.slot_minutes
        ):
            continue

        start_row = relative_start // event.slot_minutes
        end_row = relative_end // event.slot_minutes
        resolved_boundaries = []
        invalid = False
        for row in range(start_row, end_row + 1):
            boundary = base_midnight + timedelta(
                minutes=event.start_minutes + row * event.slot_minutes
            )
            candidates = valid_localizations(boundary, zone)
            if not candidates:
                dst_error = (
                    "The selected time contains a nonexistent local slot caused by "
                    "daylight saving time."
                )
                invalid = True
                break
            if len(candidates) > 1:
                dst_error = (
                    "The selected time contains an ambiguous local slot caused by "
                    "daylight saving time."
                )
                invalid = True
                break
            resolved_boundaries.append(candidates[0].astimezone(UTC))
        if invalid:
            continue
        if resolved_boundaries[0] != starts_at or resolved_boundaries[-1] != ends_at:
            continue

        group_position = selected_days.index(weekday)
        group_start = group_position * slots_per_group
        return list(range(group_start + start_row, group_start + end_row))

    if dst_error:
        raise FinalizationError(dst_error)
    if not enabled_candidate:
        raise FinalizationError("The final meeting day is not enabled for this event.")
    raise FinalizationError(
        f"The final meeting must fit inside the event window and align to "
        f"{event.slot_minutes}-minute slots."
    )


def normalize_final_time(
    event: Event,
    *,
    starts_at: datetime,
    ends_at: datetime,
    channel: str,
    location: str,
) -> dict:
    if timezone.is_naive(starts_at) or timezone.is_naive(ends_at):
        raise FinalizationError("Final meeting timestamps must include an explicit UTC offset.")
    starts_at = starts_at.astimezone(UTC)
    ends_at = ends_at.astimezone(UTC)
    if ends_at <= starts_at:
        raise FinalizationError("Final meeting end time must be after its start time.")

    allowed_channels = {
        "inperson": {"inperson"},
        "virtual": {"virtual"},
        "mixed": {"inperson", "virtual"},
    }[event.mode]
    if channel not in allowed_channels:
        raise FinalizationError(f"{channel or 'The selected channel'} is not valid for this event.")

    zone = ZoneInfo(event.timezone)
    start_local = starts_at.astimezone(zone)
    end_local = ends_at.astimezone(zone)
    if event.day_selection_type == "specific_dates":
        slot_indices = _matching_absolute_slot_indices(event, starts_at, ends_at)
    else:
        slot_indices = _weekly_slot_indices(event, starts_at, ends_at, zone)

    expected_duration = int(getattr(event, "meeting_duration_minutes", event.slot_minutes))
    actual_duration = int((ends_at - starts_at).total_seconds() // 60)
    if actual_duration != expected_duration:
        raise FinalizationError(
            f"The final meeting must be exactly {expected_duration} minutes long."
        )

    normalized_location = str(location or "").strip()
    if not normalized_location:
        normalized_location = event.location.strip() or (
            "Online" if channel == "virtual" else "Location to be confirmed"
        )
    if len(normalized_location) > 500:
        raise FinalizationError("Final meeting location is too long (max 500).")

    return {
        "starts_at": starts_at,
        "ends_at": ends_at,
        "start_local": start_local,
        "end_local": end_local,
        "slot_indices": slot_indices,
        "channel": channel,
        "location": normalized_location,
    }


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


def _request_fingerprint(event: Event, normalized: dict) -> str:
    payload = {
        "startsAt": normalized["starts_at"].isoformat(),
        "endsAt": normalized["ends_at"].isoformat(),
        "timezone": event.timezone,
        "channel": normalized["channel"],
        "location": normalized["location"],
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _meeting_matches(meeting: FinalMeeting, normalized: dict) -> bool:
    return bool(
        meeting.active
        and meeting.starts_at == normalized["starts_at"]
        and meeting.ends_at == normalized["ends_at"]
        and meeting.channel == normalized["channel"]
        and meeting.location == normalized["location"]
        and meeting.timezone == meeting.event.timezone
    )


def _confirmation_job_key(event: Event, sequence: int, recipient: str) -> str:
    recipient_hash = hashlib.sha256(recipient.encode()).hexdigest()[:24]
    return f"final-confirmation:{event.event_id}:{sequence}:{recipient_hash}"


def _cancellation_job_key(event: Event, sequence: int, recipient: str) -> str:
    recipient_hash = hashlib.sha256(recipient.encode()).hexdigest()[:24]
    return f"final-cancellation:{event.event_id}:{sequence}:{recipient_hash}"


def _message_id(prefix: str, event: Event, sequence: int, recipient: str) -> str:
    recipient_hash = hashlib.sha256(recipient.encode()).hexdigest()[:16]
    return f"<{prefix}-{event.event_id}-{sequence}-{recipient_hash}@releviz.local>"


def enqueue_final_confirmation_jobs(
    event: Event,
    meeting: FinalMeeting,
    recipients: list[str],
) -> list[EmailDeliveryJob]:
    jobs = []
    for recipient in recipients:
        attachment = final_meeting_ics(event, meeting, attendee=recipient)
        job, _created = enqueue_email_job(
            idempotency_key=_confirmation_job_key(
                event,
                meeting.calendar_sequence,
                recipient,
            ),
            message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION,
            recipient=recipient,
            subject=f"Confirmed: {event.name}",
            body=final_confirmation_body(event, meeting),
            html_body=final_confirmation_html_body(event, meeting),
            attachments=[attachment],
            message_id=_message_id(
                "final",
                event,
                meeting.calendar_sequence,
                recipient,
            ),
            event=event,
        )
        jobs.append(job)
    return jobs


def enqueue_final_cancellation_jobs(
    event: Event,
    meeting: FinalMeeting,
    recipients: list[str],
) -> list[EmailDeliveryJob]:
    jobs = []
    for recipient in recipients:
        attachment = final_meeting_ics(
            event,
            meeting,
            canceled=True,
            attendee=recipient,
        )
        job, _created = enqueue_email_job(
            idempotency_key=_cancellation_job_key(
                event,
                meeting.calendar_sequence,
                recipient,
            ),
            message_type=EmailMessageLog.MessageType.FINAL_CANCELLATION,
            recipient=recipient,
            subject=f"Scheduling reopened: {event.name}",
            body=final_cancellation_body(event, meeting),
            html_body=final_cancellation_html_body(event, meeting),
            attachments=[attachment],
            message_id=_message_id(
                "final-cancel",
                event,
                meeting.calendar_sequence,
                recipient,
            ),
            event=event,
        )
        jobs.append(job)
    return jobs


def _ensure_final_delivery_request(
    *,
    event: Event,
    requested_by,
    operation: str,
    idempotency_key,
    request_fingerprint: str,
    jobs: list[EmailDeliveryJob],
    created_job_count: int,
) -> EmailDeliveryRequest:
    request_record, created = EmailDeliveryRequest.objects.get_or_create(
        event=event,
        operation=operation,
        idempotency_key=idempotency_key,
        defaults={
            "requested_by": requested_by,
            "request_fingerprint": request_fingerprint,
            "recipient_count": len(jobs),
            "created_job_count": created_job_count,
        },
    )
    if not created and request_record.request_fingerprint != request_fingerprint:
        raise FinalizationError(
            "This delivery request key was already used with different details.",
            status_code=409,
        )
    if jobs:
        request_record.jobs.add(*jobs)
    return request_record


def _confirmation_jobs(event: Event, sequence: int) -> list[EmailDeliveryJob]:
    prefix = f"final-confirmation:{event.event_id}:{sequence}:"
    return list(event.email_delivery_jobs.filter(idempotency_key__startswith=prefix))


def _stabilize_pre_final_delivery_jobs(event: Event, *, now) -> None:
    """Prevent an availability invite from crossing the finalization barrier."""

    jobs = list(
        event.email_delivery_jobs.select_for_update()
        .filter(
            message_type__in=[
                EmailMessageLog.MessageType.INVITATION,
                EmailMessageLog.MessageType.REMINDER,
            ]
        )
        .order_by("pk")
    )
    if any(job.status == EmailDeliveryJob.Status.PROCESSING for job in jobs):
        raise FinalizationError(
            "Wait for in-progress invitations and reminders to finish before finalizing.",
            status_code=409,
        )
    cancelable_ids = [
        job.pk
        for job in jobs
        if job.status in {EmailDeliveryJob.Status.PENDING, EmailDeliveryJob.Status.RETRY}
    ]
    if cancelable_ids:
        EmailDeliveryJob.objects.filter(pk__in=cancelable_ids).update(
            status=EmailDeliveryJob.Status.CANCELED,
            last_error="The event was finalized before this message was delivered.",
            locked_at=None,
            lock_token=None,
            updated_at=now,
        )


@transaction.atomic
def confirm_final_meeting(
    *,
    event_code: str,
    organizer,
    expected_version: int,
    idempotency_key,
    starts_at: datetime,
    ends_at: datetime,
    channel: str,
    location: str,
    now=None,
) -> dict:
    current_time = now or timezone.now()
    event = (
        Event.objects.select_for_update()
        .select_related("organizer")
        .filter(code=event_code)
        .first()
    )
    if event is None:
        raise FinalizationError("Event not found.", status_code=404)
    if event.organizer_id != organizer.pk:
        raise FinalizationError(
            "Only the organizer can confirm a final meeting time.",
            status_code=403,
        )
    # Finalization is a barrier for in-flight response writes. Response paths
    # lock only their own participant row, so this waits for those commits and
    # then prevents a response from landing after the meeting is confirmed.
    list(event.participants.select_for_update().order_by("pk").values_list("pk", flat=True))
    _stabilize_pre_final_delivery_jobs(event, now=current_time)

    normalized = normalize_final_time(
        event,
        starts_at=starts_at,
        ends_at=ends_at,
        channel=channel,
        location=location,
    )
    fingerprint = _request_fingerprint(event, normalized)
    previous_request = (
        FinalizationRequest.objects.select_related("final_meeting")
        .filter(event=event, idempotency_key=idempotency_key)
        .first()
    )
    if previous_request is not None:
        if previous_request.request_fingerprint != fingerprint:
            raise FinalizationError(
                "This idempotency key was already used with different final-time details.",
                status_code=409,
            )
        if previous_request.meeting_sequence != previous_request.final_meeting.calendar_sequence:
            raise FinalizationError(
                "This confirmation was superseded after the event was reopened.",
                status_code=409,
            )
        jobs = _confirmation_jobs(event, previous_request.meeting_sequence)
        delivery_request = _ensure_final_delivery_request(
            event=event,
            requested_by=organizer,
            operation=EmailDeliveryRequest.Operation.FINAL_CONFIRMATION,
            idempotency_key=idempotency_key,
            request_fingerprint=fingerprint,
            jobs=jobs,
            created_job_count=0,
        )
        return {
            "event": event,
            "meeting": previous_request.final_meeting,
            "review": previous_request.final_meeting.attendance_snapshot,
            "jobs": [],
            "deliveryRequest": delivery_request,
            "idempotent": True,
        }

    meeting = FinalMeeting.objects.select_for_update().filter(event=event).first()
    if event.status == Event.Status.FINALIZED:
        if meeting is not None and _meeting_matches(meeting, normalized):
            FinalizationRequest.objects.create(
                event=event,
                final_meeting=meeting,
                idempotency_key=idempotency_key,
                request_fingerprint=fingerprint,
                meeting_sequence=meeting.calendar_sequence,
                resulting_event_version=event.version,
            )
            jobs = _confirmation_jobs(event, meeting.calendar_sequence)
            delivery_request = _ensure_final_delivery_request(
                event=event,
                requested_by=organizer,
                operation=EmailDeliveryRequest.Operation.FINAL_CONFIRMATION,
                idempotency_key=idempotency_key,
                request_fingerprint=fingerprint,
                jobs=jobs,
                created_job_count=0,
            )
            return {
                "event": event,
                "meeting": meeting,
                "review": meeting.attendance_snapshot,
                "jobs": [],
                "deliveryRequest": delivery_request,
                "idempotent": True,
            }
        raise FinalizationError(
            "Reopen the event before changing its confirmed meeting time.",
            status_code=409,
        )
    if event.version != expected_version:
        raise FinalizationError(
            "The event changed in another session. Refresh and review the final time again.",
            status_code=409,
        )
    if event.status not in {Event.Status.OPEN, Event.Status.CLOSED}:
        raise FinalizationError(
            f"An event cannot be finalized while it is {event.status}.",
            status_code=409,
        )

    review = build_attendance_review(event, normalized)
    if meeting is None:
        meeting = FinalMeeting.objects.create(
            event=event,
            starts_at=normalized["starts_at"],
            ends_at=normalized["ends_at"],
            timezone=event.timezone,
            channel=normalized["channel"],
            location=normalized["location"],
            calendar_uid=f"final-{event.event_id}@releviz",
            calendar_sequence=0,
            attendance_snapshot=review,
            confirmed_by=organizer,
            confirmed_at=current_time,
            active=True,
        )
    else:
        meeting.starts_at = normalized["starts_at"]
        meeting.ends_at = normalized["ends_at"]
        meeting.timezone = event.timezone
        meeting.channel = normalized["channel"]
        meeting.location = normalized["location"]
        meeting.calendar_sequence += 1
        meeting.attendance_snapshot = review
        meeting.confirmed_by = organizer
        meeting.confirmed_at = current_time
        meeting.active = True
        meeting.canceled_at = None
        meeting.save(
            update_fields=[
                "starts_at",
                "ends_at",
                "timezone",
                "channel",
                "location",
                "calendar_sequence",
                "attendance_snapshot",
                "confirmed_by",
                "confirmed_at",
                "active",
                "canceled_at",
                "updated_at",
            ]
        )

    event.status = Event.Status.FINALIZED
    event.finalized_at = current_time
    event.version += 1
    event.save(update_fields=["status", "finalized_at", "version", "updated_at"])

    jobs = enqueue_final_confirmation_jobs(
        event,
        meeting,
        final_notification_recipients(event),
    )
    delivery_request = _ensure_final_delivery_request(
        event=event,
        requested_by=organizer,
        operation=EmailDeliveryRequest.Operation.FINAL_CONFIRMATION,
        idempotency_key=idempotency_key,
        request_fingerprint=fingerprint,
        jobs=jobs,
        created_job_count=len(jobs),
    )
    FinalizationRequest.objects.create(
        event=event,
        final_meeting=meeting,
        idempotency_key=idempotency_key,
        request_fingerprint=fingerprint,
        meeting_sequence=meeting.calendar_sequence,
        resulting_event_version=event.version,
    )
    return {
        "event": event,
        "meeting": meeting,
        "review": review,
        "jobs": jobs,
        "deliveryRequest": delivery_request,
        "idempotent": False,
    }


@transaction.atomic
def cancel_active_final_meeting(event: Event, *, now=None) -> list[EmailDeliveryJob]:
    meeting = FinalMeeting.objects.select_for_update().filter(event=event, active=True).first()
    if meeting is None:
        return []
    previous_sequence = meeting.calendar_sequence
    prefix = f"final-confirmation:{event.event_id}:{previous_sequence}:"
    confirmation_jobs = list(
        event.email_delivery_jobs.select_for_update()
        .filter(idempotency_key__startswith=prefix)
        .order_by("recipient")
    )
    current_time = now or timezone.now()
    cancelable_ids = [
        job.pk
        for job in confirmation_jobs
        if job.status in {EmailDeliveryJob.Status.PENDING, EmailDeliveryJob.Status.RETRY}
    ]
    if cancelable_ids:
        EmailDeliveryJob.objects.filter(pk__in=cancelable_ids).update(
            status=EmailDeliveryJob.Status.CANCELED,
            last_error="The confirmed meeting was canceled before delivery.",
            locked_at=None,
            lock_token=None,
            updated_at=current_time,
        )
    processing_jobs = [
        job for job in confirmation_jobs if job.status == EmailDeliveryJob.Status.PROCESSING
    ]
    for job in processing_jobs:
        # The provider call may already be in flight. Do not retry it after this
        # attempt, and queue a CANCEL that the worker holds until it is terminal.
        job.max_attempts = max(1, job.attempt_count)
        job.updated_at = current_time
    if processing_jobs:
        EmailDeliveryJob.objects.bulk_update(processing_jobs, ["max_attempts", "updated_at"])
    recipients = sorted(
        {
            job.recipient
            for job in confirmation_jobs
            if job.status in {EmailDeliveryJob.Status.SENT, EmailDeliveryJob.Status.PROCESSING}
        }
    )
    meeting.active = False
    meeting.canceled_at = current_time
    meeting.calendar_sequence += 1
    meeting.save(
        update_fields=[
            "active",
            "canceled_at",
            "calendar_sequence",
            "updated_at",
        ]
    )
    jobs = enqueue_final_cancellation_jobs(event, meeting, recipients)
    request_fingerprint = hashlib.sha256(
        json.dumps(
            {
                "meetingSequence": meeting.calendar_sequence,
                "recipients": recipients,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    request_key = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"releviz:final-cancellation:{event.event_id}:{meeting.calendar_sequence}",
    )
    _ensure_final_delivery_request(
        event=event,
        requested_by=event.organizer,
        operation=EmailDeliveryRequest.Operation.FINAL_CANCELLATION,
        idempotency_key=request_key,
        request_fingerprint=request_fingerprint,
        jobs=jobs,
        created_job_count=len(jobs),
    )
    return jobs


def final_delivery_summary(event: Event, meeting: FinalMeeting) -> dict:
    prefix = f"final-confirmation:{event.event_id}:{meeting.calendar_sequence}:"
    jobs = list(event.email_delivery_jobs.filter(idempotency_key__startswith=prefix))
    statuses = {
        status: sum(job.status == status for job in jobs)
        for status in EmailDeliveryJob.Status.values
    }
    return {
        "recipientTotal": len(jobs),
        "pending": statuses[EmailDeliveryJob.Status.PENDING],
        "processing": statuses[EmailDeliveryJob.Status.PROCESSING],
        "retry": statuses[EmailDeliveryJob.Status.RETRY],
        "sent": statuses[EmailDeliveryJob.Status.SENT],
        "permanentFailure": statuses[EmailDeliveryJob.Status.PERMANENT_FAILURE],
    }
