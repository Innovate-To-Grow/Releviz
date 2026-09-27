"""Previews of the event emails an organizer sends besides invitations and reminders.

Each preview is built from the same parts the real send uses, for the first
recipient the send would email, and nothing is saved or queued. Invitation
and reminder previews live with the invitations.
"""

from django.utils import timezone

from apps.mail.models import EmailDeliveryJob
from apps.mail.previews import job_email_preview
from apps.scheduling.models import Event, FinalMeeting

from .finalization import (
    confirmation_jobs,
    final_cancellation_parts,
    final_cancellation_recipients,
    final_confirmation_parts,
    final_notification_recipients,
)
from .invitations.links import PREVIEW_INVITATION_TOKEN
from .invitations.previews import no_email_preview, recipient_name, sampled_email_preview


def _recipients_preview(event: Event, recipients: list[str], parts_for) -> dict:
    """``recipientCount``, plus the email the first of ``recipients`` would get.

    ``parts_for(recipient)`` builds that recipient's message parts.
    """

    if not recipients:
        return {"recipientCount": 0, **no_email_preview()}
    recipient = recipients[0]
    return {
        "recipientCount": len(recipients),
        **sampled_email_preview(
            name=recipient_name(event, recipient),
            email=recipient,
            parts=parts_for(recipient),
        ),
    }


def proposed_final_meeting(event: Event, normalized: dict) -> FinalMeeting:
    """The meeting confirming ``normalized`` would set up, unsaved.

    It is deliberately not attached to ``event``: assigning a one-to-one
    would also replace the event's cached ``final_meeting``.
    """

    return FinalMeeting(
        starts_at=normalized["starts_at"],
        ends_at=normalized["ends_at"],
        timezone=event.timezone,
        channel=normalized["channel"],
        location=normalized["location"],
        calendar_uid=f"final-{event.event_id}@releviz",
        confirmed_at=timezone.now(),
    )


def final_confirmation_preview(event: Event, normalized: dict) -> dict:
    """The confirmation finalizing at the ``normalized`` time would email."""

    meeting = proposed_final_meeting(event, normalized)
    return _recipients_preview(
        event,
        final_notification_recipients(event),
        lambda recipient: final_confirmation_parts(event, meeting, recipient),
    )


def final_cancellation_preview(event: Event) -> dict:
    """The cancellations reopening ``event`` would email.

    The same recipients ``cancel_active_final_meeting`` picks: everyone the
    active meeting's confirmation may have reached. With no active meeting
    nobody is emailed.
    """

    meeting = FinalMeeting.objects.filter(event=event, active=True).first()
    jobs = confirmation_jobs(event, meeting.calendar_sequence) if meeting is not None else []
    return _recipients_preview(
        event,
        final_cancellation_recipients(jobs),
        lambda recipient: final_cancellation_parts(event, meeting, recipient),
    )


def delivery_job_preview(event: Event, job: EmailDeliveryJob) -> dict:
    """What retrying ``job`` sends: the stored email, without the private link's token."""

    name = recipient_name(event, job.recipient)
    email = job_email_preview(job, name=name)
    if job.invitation is not None:
        token = str(job.invitation.access_token)
        for part in ("text", "html"):
            email[part] = email[part].replace(token, PREVIEW_INVITATION_TOKEN)
    return {"email": email, "sample": {"name": name, "email": job.recipient}}
