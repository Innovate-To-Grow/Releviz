"""Delivery jobs and requests for final meeting notifications."""

import hashlib
import json

from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.mail.services import enqueue_email_job
from apps.scheduling.models import Event, FinalMeeting
from apps.scheduling.services.ics import final_meeting_ics

from .errors import FinalizationError
from .messages import (
    final_cancellation_body,
    final_cancellation_html_body,
    final_confirmation_body,
    final_confirmation_html_body,
)


def final_request_fingerprint(event: Event, normalized: dict) -> str:
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


def ensure_final_delivery_request(
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


def confirmation_jobs(event: Event, sequence: int) -> list[EmailDeliveryJob]:
    prefix = f"final-confirmation:{event.event_id}:{sequence}:"
    return list(event.email_delivery_jobs.filter(idempotency_key__startswith=prefix))


def stabilize_pre_final_delivery_jobs(event: Event, *, now) -> None:
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
