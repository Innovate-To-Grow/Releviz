"""Subject, text, and HTML bodies for invitation and reminder emails."""

from apps.mail.email_templates import render_branded_email
from apps.mail.services import EmailAttachment
from apps.scheduling.models import Event, EventInvitation
from apps.scheduling.services.email_formatting import (
    format_email_datetime,
    local_datetime,
    nowrap_times,
    zone_label,
    zone_suffix,
)
from apps.scheduling.services.ics import response_deadline_ics

from .links import invitation_link


def response_deadline_text(event: Event) -> str:
    """The deadline as recipients read it, naming the event's zone when the label does not."""

    deadline = local_datetime(event.response_deadline, event.timezone)
    return format_email_datetime(deadline, event.timezone) + zone_suffix(
        event.timezone, zone_label(deadline)
    )


def invitation_body(
    invitation: EventInvitation,
    *,
    reminder: bool = False,
    link: str | None = None,
) -> str:
    """The plain-text part. ``link`` replaces the recipient's own private link."""

    event = invitation.event
    link = invitation_link(invitation) if link is None else link
    is_temporary = (
        invitation.member is not None
        and getattr(invitation.member, "access_level", "full") == "temporary"
    )
    greeting = "Reminder:" if reminder else "You are invited to share your availability."
    custom = (
        f"\n\nMessage from organizer:\n{invitation.custom_message}"
        if invitation.custom_message
        else ""
    )
    deadline = (
        f"\n\nPlease respond by {response_deadline_text(event)}." if event.response_deadline else ""
    )
    access_instruction = (
        "Open the link to share your availability. It is private to you and only grants "
        "access to this event, so please do not forward it."
        if is_temporary
        else (
            "Log in or create a Releviz account with this email address to fill out your schedule."
        )
    )
    return (
        f"{greeting}\n\nEvent: {event.name}\nLink: {link}{deadline}{custom}\n\n{access_instruction}"
    )


def invitation_html_body(
    invitation: EventInvitation,
    *,
    reminder: bool = False,
    link: str | None = None,
) -> str:
    """The HTML part. ``link`` replaces the recipient's own private link."""

    event = invitation.event
    link = invitation_link(invitation) if link is None else link
    is_temporary = (
        invitation.member is not None
        and getattr(invitation.member, "access_level", "full") == "temporary"
    )
    details = [("Event", event.name)]
    if event.response_deadline:
        details.append(("Respond by", nowrap_times(response_deadline_text(event))))
    return render_branded_email(
        title="Availability reminder" if reminder else "You're invited",
        preheader=(
            f"Please add your availability for {event.name}."
            if reminder
            else f"Share your availability for {event.name}."
        ),
        eyebrow="Reminder" if reminder else "Event invitation",
        paragraphs=(
            "The organizer is still waiting for your availability."
            if reminder
            else "Choose the times that work for you so the group can find the best option.",
        ),
        details=details,
        cta_label="Share your availability",
        cta_url=link,
        notice="\n\n".join(
            item
            for item in [
                (
                    "This private link is only for you and only grants access to this event. "
                    "Please do not forward it."
                    if is_temporary
                    else ""
                ),
                (
                    f"Message from the organizer:\n{invitation.custom_message}"
                    if invitation.custom_message
                    else ""
                ),
            ]
            if item
        ),
    )


def event_email_parts(
    invitation: EventInvitation,
    *,
    reminder: bool,
    link: str | None = None,
) -> tuple[str, str, str, list[EmailAttachment]]:
    """Subject, text, HTML, and attachments of an invitation or reminder.

    ``link`` stands in for the recipient's private link everywhere it
    appears; previews pass one so they never show a real access token.
    """

    event = invitation.event
    link = invitation_link(invitation) if link is None else link
    attachment = response_deadline_ics(event, link=link)
    subject = (
        f"Reminder: share your availability for {event.name}"
        if reminder
        else f"Share your availability for {event.name}"
    )
    return (
        subject,
        invitation_body(invitation, reminder=reminder, link=link),
        invitation_html_body(invitation, reminder=reminder, link=link),
        [attachment] if attachment else [],
    )
