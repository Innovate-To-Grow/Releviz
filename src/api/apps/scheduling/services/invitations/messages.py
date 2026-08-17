"""Subject, text, and HTML bodies for invitation and reminder emails."""

from apps.mail.email_templates import render_branded_email
from apps.mail.services import EmailAttachment
from apps.scheduling.models import EventInvitation
from apps.scheduling.services.ics import response_deadline_ics

from .links import invitation_link


def invitation_body(invitation: EventInvitation, *, reminder: bool = False) -> str:
    event = invitation.event
    link = invitation_link(invitation)
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
        f"\n\nPlease respond by {event.response_deadline.isoformat()}."
        if event.response_deadline
        else ""
    )
    access_instruction = (
        "Open the link and enter the six-digit code sent to this email address."
        if is_temporary
        else (
            "Log in or create a Releviz account with this email address to fill out your schedule."
        )
    )
    return (
        f"{greeting}\n\nEvent: {event.name}\nLink: {link}{deadline}{custom}\n\n{access_instruction}"
    )


def invitation_html_body(invitation: EventInvitation, *, reminder: bool = False) -> str:
    event = invitation.event
    link = invitation_link(invitation)
    is_temporary = (
        invitation.member is not None
        and getattr(invitation.member, "access_level", "full") == "temporary"
    )
    details = [("Event", event.name)]
    if event.response_deadline:
        details.append(("Respond by", event.response_deadline.isoformat()))
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
                    "Open this private link and enter the six-digit code sent to this "
                    "email address. The link only grants access to this event."
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
) -> tuple[str, str, str, list[EmailAttachment]]:
    event = invitation.event
    attachment = response_deadline_ics(event, link=invitation_link(invitation))
    subject = (
        f"Reminder: share your availability for {event.name}"
        if reminder
        else f"Share your availability for {event.name}"
    )
    return (
        subject,
        invitation_body(invitation, reminder=reminder),
        invitation_html_body(invitation, reminder=reminder),
        [attachment] if attachment else [],
    )
