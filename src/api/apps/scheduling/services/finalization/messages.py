"""Text and HTML bodies for final meeting confirmations and cancellations."""

from apps.mail.email_templates import render_branded_email
from apps.mail.services import frontend_url
from apps.scheduling.models import Event
from apps.scheduling.services.email_formatting import (
    format_email_time_range,
    meeting_method_label,
    nowrap_times,
)


def _confirmation_details(meeting) -> list[tuple[str, str]]:
    """The meeting as recipients read it; a blank location is left out."""

    details = [
        (
            "When",
            format_email_time_range(meeting.starts_at, meeting.ends_at, meeting.timezone),
        ),
        ("Timezone", meeting.timezone),
        ("Method", meeting_method_label(meeting.channel)),
    ]
    location = (meeting.location or "").strip()
    if location:
        details.append(("Location", location))
    return details


def final_confirmation_body(event: Event, meeting) -> str:
    lines = "".join(f"{label}: {value}\n" for label, value in _confirmation_details(meeting))
    return (
        f"The final meeting time for {event.name} is confirmed.\n\n"
        f"{lines}"
        f"Event: {frontend_url('/event', code=event.code)}\n\n"
        "A calendar invitation is attached."
    )


def final_confirmation_html_body(event: Event, meeting) -> str:
    return render_branded_email(
        title="Meeting confirmed",
        preheader=f"The final time for {event.name} is confirmed.",
        eyebrow="Final schedule",
        paragraphs=(f"The final meeting time for {event.name} is confirmed.",),
        details=[(label, nowrap_times(value)) for label, value in _confirmation_details(meeting)],
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
