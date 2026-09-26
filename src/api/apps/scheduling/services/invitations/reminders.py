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


def reminder_candidates(event: Event):
    """The invitations a reminder run considers: sent at least once, not submitted.

    Whether reminders are enabled is decided by the caller.
    """

    return event.invitations.filter(first_sent_at__isnull=False).exclude(
        status=EventInvitation.Status.SUBMITTED
    )


def reminder_job_key_prefix(event: Event, invitation_pk, cycle: str) -> str:
    """The start every reminder job key for ``invitation_pk`` in ``cycle`` shares.

    The full key adds the content fingerprint, so a reminder whose wording
    changed within one cycle gets a fresh job.
    """

    return f"reminder:{event.event_id}:{invitation_pk}:{cycle}:"


def reminded_invitation_ids(event: Event, invitation_ids) -> set:
    """Ids among ``invitation_ids`` that already hold a reminder job for the
    current cycle, whatever became of that job."""

    cycle = reminder_cycle(event)
    prefixes = {pk: reminder_job_key_prefix(event, pk, cycle) for pk in invitation_ids}
    jobs = EmailDeliveryJob.objects.filter(
        invitation_id__in=prefixes,
        message_type=EmailMessageLog.MessageType.REMINDER,
    ).values_list("invitation_id", "idempotency_key")
    return {invitation_id for invitation_id, key in jobs if key.startswith(prefixes[invitation_id])}


def automatic_reminder_at(event: Event):
    """When the scheduled reminder for ``event`` goes out; needs a deadline."""

    return event.response_deadline - timedelta(hours=event.reminder_hours_before)


def next_automatic_reminder_at(event: Event, *, now=None):
    """The scheduled reminder still ahead, or ``None`` when no reminder is due."""

    if (
        not event.reminders_enabled
        or event.status != Event.Status.ACTIVE
        or event.response_deadline is None
    ):
        return None
    reminder_at = automatic_reminder_at(event)
    return reminder_at if reminder_at > (now or timezone.now()) else None


def reminder_preview(event: Event) -> dict:
    """What a manual reminder run would do now, without doing it.

    ``eligible`` ignores ``reminders_enabled`` so the organizer sees who a
    run would reach once reminders are on; ``alreadyReminded`` are the
    eligible people this cycle already queued a reminder for.
    """

    invitation_ids = list(reminder_candidates(event).values_list("pk", flat=True))
    already_reminded = len(reminded_invitation_ids(event, invitation_ids))
    return {
        "remindersEnabled": event.reminders_enabled,
        "eligible": len(invitation_ids),
        "alreadyReminded": already_reminded,
        "wouldEnqueue": len(invitation_ids) - already_reminded,
        "nextAutomaticAt": next_automatic_reminder_at(event),
        "deadline": event.response_deadline,
    }


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
            reminder_job_key_prefix(event, invitation.pk, cycle) + content_fingerprint
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
    invitations = reminder_candidates(event)
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
        if automatic_reminder_at(event) <= window_end:
            count += send_event_reminders(event, force=False)
    return count
