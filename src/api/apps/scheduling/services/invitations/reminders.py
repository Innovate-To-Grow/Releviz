"""Availability reminder cycles and their delivery jobs."""

import hashlib
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.mail.services import enqueue_email_job
from apps.scheduling.models import Event, EventInvitation
from apps.scheduling.services.events.lifecycle import response_write_error
from apps.scheduling.services.fingerprints import email_content_fingerprint

from .messages import event_email_parts


def reminder_cycle(event: Event) -> str:
    deadline = event.response_deadline.isoformat() if event.response_deadline else "no-deadline"
    return hashlib.sha256(deadline.encode()).hexdigest()[:24]


def enqueue_reminder_job(invitation: EventInvitation) -> tuple[EmailDeliveryJob, bool]:
    event = invitation.event
    subject, body, html_body, attachments = event_email_parts(invitation, reminder=True)
    cycle = reminder_cycle(event)
    content_fingerprint = email_content_fingerprint(
        subject=subject,
        body=body,
        html_body=html_body,
        attachments=attachments,
    )
    return enqueue_email_job(
        idempotency_key=(
            f"reminder:{event.event_id}:{invitation.pk}:{cycle}:{content_fingerprint}"
        ),
        message_type=EmailMessageLog.MessageType.REMINDER,
        recipient=invitation.email,
        subject=subject,
        body=body,
        html_body=html_body,
        attachments=attachments,
        message_id=(
            f"<reminder-{event.event_id}-{invitation.pk}-{cycle}-"
            f"{content_fingerprint[:16]}@releviz.local>"
        ),
        event=event,
        invitation=invitation,
    )


@transaction.atomic
def send_event_reminders(event: Event, *, force: bool = False) -> int:
    event = Event.objects.select_for_update().get(pk=event.pk)
    if response_write_error(event) or not event.reminders_enabled:
        return 0
    invitations = event.invitations.filter(first_sent_at__isnull=False).exclude(
        status=EventInvitation.Status.SUBMITTED
    )
    if not force:
        invitations = invitations.filter(reminder_sent_at__isnull=True)
    count = 0
    for invitation in invitations.select_related("event"):
        _job, created = enqueue_reminder_job(invitation)
        count += int(created)
    return count


def send_due_event_reminders(*, window_minutes: int) -> int:
    now = timezone.now()
    window_end = now + timedelta(minutes=window_minutes)
    count = 0
    events = Event.objects.filter(
        status=Event.Status.ACTIVE,
        reminders_enabled=True,
        response_deadline__isnull=False,
        response_deadline__gt=now,
    )
    for event in events:
        reminder_at = event.response_deadline - timedelta(hours=event.reminder_hours_before)
        if reminder_at <= window_end:
            count += send_event_reminders(event, force=False)
    return count
