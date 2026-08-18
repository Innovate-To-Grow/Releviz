"""Text and HTML bodies for final meeting confirmations and cancellations."""

from zoneinfo import ZoneInfo

from apps.mail.email_templates import render_branded_email
from apps.mail.services import frontend_url
from apps.scheduling.models import Event


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
