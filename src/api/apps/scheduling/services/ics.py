"""iCalendar attachments for availability deadlines and final meetings."""

from datetime import UTC, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

from apps.mail.services import EmailAttachment, frontend_url
from apps.scheduling.models import Event


def _ics_escape(value: str) -> str:
    return (
        str(value or "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def _ics_datetime(value) -> str:
    aware = value if timezone.is_aware(value) else timezone.make_aware(value, UTC)
    return aware.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _fold_ics_line(line: str) -> list[str]:
    folded = []
    current = ""
    prefix = ""
    for character in line:
        candidate = f"{prefix}{current}{character}"
        if current and len(candidate.encode("utf-8")) > 75:
            folded.append(f"{prefix}{current}")
            prefix = " "
            current = character
        else:
            current += character
    folded.append(f"{prefix}{current}")
    return folded


def _ics_content(lines: list[str]) -> str:
    return "\r\n".join(
        [physical_line for line in lines for physical_line in _fold_ics_line(line)] + [""]
    )


def response_deadline_ics(event: Event, *, link: str = "") -> EmailAttachment | None:
    if not event.response_deadline:
        return None
    link = link or frontend_url("/event", code=event.code)
    starts_at = event.response_deadline
    ends_at = starts_at + timedelta(minutes=15)
    alarm_hours = max(int(event.reminder_hours_before or 0), 0)
    content = _ics_content(
        [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Releviz//Releviz//EN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            "BEGIN:VEVENT",
            f"UID:availability-{event.event_id}@releviz",
            f"DTSTAMP:{_ics_datetime(event.updated_at or event.response_deadline)}",
            f"DTSTART:{_ics_datetime(starts_at)}",
            f"DTEND:{_ics_datetime(ends_at)}",
            f"SUMMARY:{_ics_escape(f'Fill availability for {event.name}')}",
            f"DESCRIPTION:{_ics_escape(f'Fill out your availability: {link}')}",
            f"URL:{_ics_escape(link)}",
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            f"DESCRIPTION:{_ics_escape(f'Fill availability for {event.name}')}",
            f"TRIGGER:-PT{alarm_hours}H",
            "END:VALARM",
            "END:VEVENT",
            "END:VCALENDAR",
        ]
    )
    return EmailAttachment(
        filename=f"releviz-{event.code}-availability.ics",
        content=content,
        mimetype="text/calendar; charset=utf-8",
    )


def final_meeting_ics(
    event: Event,
    meeting,
    *,
    canceled: bool = False,
    attendee: str = "",
) -> EmailAttachment:
    link = frontend_url("/event", code=event.code)
    method = "CANCEL" if canceled else "REQUEST"
    status = "CANCELLED" if canceled else "CONFIRMED"
    local_start = meeting.starts_at.astimezone(ZoneInfo(meeting.timezone))
    local_end = meeting.ends_at.astimezone(ZoneInfo(meeting.timezone))
    description = (
        f"{event.name} is no longer confirmed for "
        f"{local_start.isoformat()} to {local_end.isoformat()} ({meeting.timezone})."
        if canceled
        else (
            f"Confirmed for {local_start.isoformat()} to {local_end.isoformat()} "
            f"({meeting.timezone}). Event page: {link}"
        )
    )
    organizer_email = event.organizer.get_primary_email()
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Releviz//Releviz//EN",
        "CALSCALE:GREGORIAN",
        f"METHOD:{method}",
        f"X-WR-TIMEZONE:{_ics_escape(meeting.timezone)}",
        "BEGIN:VEVENT",
        f"UID:{_ics_escape(meeting.calendar_uid)}",
        f"SEQUENCE:{meeting.calendar_sequence}",
        f"DTSTAMP:{_ics_datetime(meeting.updated_at or meeting.confirmed_at)}",
        f"DTSTART:{_ics_datetime(meeting.starts_at)}",
        f"DTEND:{_ics_datetime(meeting.ends_at)}",
        f"SUMMARY:{_ics_escape(event.name)}",
        f"DESCRIPTION:{_ics_escape(description)}",
        f"LOCATION:{_ics_escape(meeting.location)}",
        f"URL:{_ics_escape(link)}",
        f"STATUS:{status}",
        "TRANSP:OPAQUE",
    ]
    if organizer_email:
        lines.append(f"ORGANIZER:mailto:{_ics_escape(organizer_email)}")
    if attendee:
        lines.append(f"ATTENDEE;RSVP=TRUE:mailto:{_ics_escape(attendee)}")
    lines.extend(["END:VEVENT", "END:VCALENDAR"])
    content = _ics_content(lines)
    return EmailAttachment(
        filename=f"releviz-{event.code}-final.ics",
        content=content,
        mimetype="text/calendar; charset=utf-8; method=" + method.lower(),
    )
