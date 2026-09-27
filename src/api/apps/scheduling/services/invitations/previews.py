"""Previews of invitation and reminder emails, rendered for one sample recipient."""

from apps.mail.previews import email_preview
from apps.scheduling.models import Event, EventInvitation

from .links import preview_invitation_link
from .messages import event_email_parts


def no_email_preview() -> dict:
    """The preview fields when nobody would be emailed."""

    return {"email": None, "sample": None}


def recipient_name(event: Event, email: str) -> str:
    """The roster name of whoever ``email`` reaches in ``event``, or ``""``.

    That is the participant whose account holds the event's invitation to
    ``email``; an address invited on its own has no roster name.
    """

    name = (
        event.participants.filter(
            member__event_invitations__event=event,
            member__event_invitations__email=email,
        )
        .order_by("pk")
        .values_list("participant_name", flat=True)
        .first()
    )
    return name or ""


def sampled_email_preview(*, name: str, email: str, parts) -> dict:
    """``email`` and ``sample`` for the message ``parts`` sent to ``email``.

    ``parts`` are the subject, text, HTML, and attachments the real send
    builds for that recipient.
    """

    subject, body, html_body, attachments = parts
    return {
        "email": email_preview(
            recipient=email,
            name=name,
            subject=subject,
            body=body,
            html_body=html_body,
            attachments=attachments,
        ),
        "sample": {"name": name, "email": email},
    }


def invitation_email_preview(invitation: EventInvitation, *, name: str, reminder: bool) -> dict:
    """The invitation or reminder ``invitation`` would send, with a stand-in link.

    ``invitation`` may be unsaved: someone about to be invited for the first
    time is previewed with an invitation that only exists in memory.
    """

    return sampled_email_preview(
        name=name,
        email=invitation.email,
        parts=event_email_parts(
            invitation,
            reminder=reminder,
            link=preview_invitation_link(invitation),
        ),
    )
