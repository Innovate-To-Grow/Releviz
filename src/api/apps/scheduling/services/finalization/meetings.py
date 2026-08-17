"""Confirm and cancel the final meeting of an event."""

import hashlib
import json
import uuid
from datetime import datetime

from django.db import transaction
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest
from apps.scheduling.models import Event, FinalizationRequest, FinalMeeting

from .attendance import build_attendance_review, final_notification_recipients
from .delivery import (
    confirmation_jobs,
    enqueue_final_cancellation_jobs,
    enqueue_final_confirmation_jobs,
    ensure_final_delivery_request,
    final_request_fingerprint,
    stabilize_pre_final_delivery_jobs,
)
from .errors import FinalizationError
from .slot_matching import normalize_final_time


def _meeting_matches(meeting: FinalMeeting, normalized: dict) -> bool:
    return bool(
        meeting.active
        and meeting.starts_at == normalized["starts_at"]
        and meeting.ends_at == normalized["ends_at"]
        and meeting.channel == normalized["channel"]
        and meeting.location == normalized["location"]
        and meeting.timezone == meeting.event.timezone
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
    stabilize_pre_final_delivery_jobs(event, now=current_time)

    normalized = normalize_final_time(
        event,
        starts_at=starts_at,
        ends_at=ends_at,
        channel=channel,
        location=location,
    )
    fingerprint = final_request_fingerprint(event, normalized)
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
        jobs = confirmation_jobs(event, previous_request.meeting_sequence)
        delivery_request = ensure_final_delivery_request(
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
            jobs = confirmation_jobs(event, meeting.calendar_sequence)
            delivery_request = ensure_final_delivery_request(
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
    if event.status not in {Event.Status.ACTIVE, Event.Status.CLOSED}:
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
    delivery_request = ensure_final_delivery_request(
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
    ensure_final_delivery_request(
        event=event,
        requested_by=event.organizer,
        operation=EmailDeliveryRequest.Operation.FINAL_CANCELLATION,
        idempotency_key=request_key,
        request_fingerprint=request_fingerprint,
        jobs=jobs,
        created_job_count=len(jobs),
    )
    return jobs
