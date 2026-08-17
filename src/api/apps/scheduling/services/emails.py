"""Subject-line and body copy for the emails the scheduling app sends."""

from __future__ import annotations

from zoneinfo import ZoneInfo

from apps.mail.email_templates import render_branded_email
from apps.mail.services import frontend_url
from apps.scheduling.models import Event, EventInvitation


def final_confirmation_body(event: Event, meeting) -> str:
    starts_at = meeting.starts_at.astimezone(ZoneInfo(meeting.timezone))
    ends_at = meeting.ends_at.astimezone(ZoneInfo(meeting.timezone))
    return (
        f"The final meeting time for {event.name} is confirmed.\n\n"
        f"Starts: {starts_at.isoformat()}\n"
        f"Ends: {ends_at.isoformat()}\n"
        f"Timezone: {meeting.timezone}\n"
        f"Method: {meeting.channel}\n"
        f"Location: {meeting.location}\n"
        f"Event: {frontend_url('/event', code=event.code)}\n\n"
        "A calendar invitation is attached."
    )


def final_confirmation_html_body(event: Event, meeting) -> str:
    starts_at = meeting.starts_at.astimezone(ZoneInfo(meeting.timezone))
    ends_at = meeting.ends_at.astimezone(ZoneInfo(meeting.timezone))
    return render_branded_email(
        title="Meeting confirmed",
        preheader=f"The final time for {event.name} is confirmed.",
        eyebrow="Final schedule",
        paragraphs=(f"The final meeting time for {event.name} is confirmed.",),
        details=(
            ("Starts", starts_at.isoformat()),
            ("Ends", ends_at.isoformat()),
            ("Timezone", meeting.timezone),
            ("Method", meeting.channel),
            ("Location", meeting.location),
        ),
        cta_label="View event",
        cta_url=frontend_url("/event", code=event.code),
        notice="A calendar invitation is attached to this email.",
    )


def final_cancellation_body(event: Event, meeting) -> str:
    return (
        f"Scheduling for {event.name} has reopened.\n\n"
        "The previously confirmed calendar invitation has been canceled. "
        f"Check the event for updates: {frontend_url('/event', code=event.code)}"
    )


def final_cancellation_html_body(event: Event, meeting) -> str:
    return render_branded_email(
        title="Scheduling reopened",
        preheader=f"{event.name} is collecting availability again.",
        eyebrow="Schedule update",
        paragraphs=(
            f"Scheduling for {event.name} has reopened.",
            "The previously confirmed calendar invitation has been canceled. "
            "Check the event for the latest options.",
        ),
        cta_label="View updated event",
        cta_url=frontend_url("/event", code=event.code),
    )


def invitation_link(invitation: EventInvitation) -> str:
    member = invitation.member
    path = (
        "/temp-access"
        if member is not None and getattr(member, "access_level", "full") == "temporary"
        else "/event"
    )
    return frontend_url(
        path,
        code=invitation.event.code,
        invitation=str(invitation.access_token),
    )


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
