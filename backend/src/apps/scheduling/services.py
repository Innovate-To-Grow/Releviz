from __future__ import annotations

import re
from datetime import UTC, timedelta

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.messaging.models import EmailMessageLog
from apps.messaging.services import EmailAttachment, frontend_url, send_email_message
from apps.scheduling.models import Event, EventInvitation


def split_invitation_emails(value) -> tuple[list[str], list[str]]:
    raw_items = value if isinstance(value, list) else re.split(r"[\s,;]+", str(value or ""))
    emails: list[str] = []
    invalid: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        email = str(item or "").strip().lower()
        if not email:
            continue
        try:
            validate_email(email)
        except ValidationError:
            invalid.append(email)
            continue
        if email not in seen:
            seen.add(email)
            emails.append(email)
    return emails, invalid


def resolve_invited_member(email: str):
    contact = (
        ContactEmail.objects.select_related("member")
        .filter(email_address__iexact=email, verified=True, member__is_active=True)
        .first()
    )
    return contact.member if contact else None


def api_invitation(invitation: EventInvitation) -> dict:
    return {
        "id": invitation.pk,
        "email": invitation.email,
        "memberId": str(invitation.member_id) if invitation.member_id else None,
        "status": invitation.status,
        "lastSentAt": invitation.last_sent_at.isoformat() if invitation.last_sent_at else None,
        "reminderSentAt": invitation.reminder_sent_at.isoformat()
        if invitation.reminder_sent_at
        else None,
        "acceptedAt": invitation.accepted_at.isoformat() if invitation.accepted_at else None,
        "customMessage": invitation.custom_message,
    }


def _ics_escape(value: str) -> str:
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def _ics_datetime(value) -> str:
    aware = value if timezone.is_aware(value) else timezone.make_aware(value, UTC)
    return aware.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def response_deadline_ics(event: Event) -> EmailAttachment | None:
    if not event.response_deadline:
        return None
    link = frontend_url("/event", code=event.code)
    starts_at = event.response_deadline
    ends_at = starts_at + timedelta(minutes=15)
    alarm_hours = max(int(event.reminder_hours_before or 0), 0)
    content = "\r\n".join(
        [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Releviz//Scheduler//EN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            "BEGIN:VEVENT",
            f"UID:availability-{event.event_id}@releviz",
            f"DTSTAMP:{_ics_datetime(timezone.now())}",
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
            "",
        ]
    )
    return EmailAttachment(
        filename=f"releviz-{event.code}-availability.ics",
        content=content,
        mimetype="text/calendar; charset=utf-8",
    )


def invitation_body(invitation: EventInvitation, *, reminder: bool = False) -> str:
    event = invitation.event
    link = frontend_url("/event", code=event.code)
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
    return (
        f"{greeting}\n\n"
        f"Event: {event.name}\n"
        f"Link: {link}"
        f"{deadline}"
        f"{custom}\n\n"
        "Log in or create a Releviz account with this email address to fill out your schedule."
    )


def send_invitation_email(invitation: EventInvitation) -> None:
    event = invitation.event
    attachment = response_deadline_ics(event)
    send_email_message(
        subject=f"Share your availability for {event.name}",
        body=invitation_body(invitation),
        recipients=[invitation.email],
        message_type=EmailMessageLog.MessageType.INVITATION,
        attachments=[attachment] if attachment else [],
        event=event,
        invitation=invitation,
    )
    invitation.last_sent_at = timezone.now()
    invitation.save(update_fields=["last_sent_at", "updated_at"])


def send_reminder_email(invitation: EventInvitation) -> None:
    event = invitation.event
    attachment = response_deadline_ics(event)
    send_email_message(
        subject=f"Reminder: share your availability for {event.name}",
        body=invitation_body(invitation, reminder=True),
        recipients=[invitation.email],
        message_type=EmailMessageLog.MessageType.REMINDER,
        attachments=[attachment] if attachment else [],
        event=event,
        invitation=invitation,
    )
    invitation.reminder_sent_at = timezone.now()
    invitation.save(update_fields=["reminder_sent_at", "updated_at"])


@transaction.atomic
def upsert_and_send_invitations(
    *, event: Event, emails: list[str], invited_by, message: str = ""
) -> list[EventInvitation]:
    invitations: list[EventInvitation] = []
    for email in emails:
        invitation, _ = EventInvitation.objects.update_or_create(
            event=event,
            email=email,
            defaults={
                "member": resolve_invited_member(email),
                "invited_by": invited_by,
                "custom_message": message,
            },
        )
        send_invitation_email(invitation)
        invitations.append(invitation)
    return invitations


def mark_invitation_for_member(*, event: Event, member, submitted: bool = False) -> None:
    emails = list(
        ContactEmail.objects.filter(member=member, verified=True).values_list(
            "email_address",
            flat=True,
        )
    )
    if member.email:
        emails.append(member.email)
    normalized = {email.strip().lower() for email in emails if email}
    if not normalized:
        return
    status = EventInvitation.Status.SUBMITTED if submitted else EventInvitation.Status.ACCEPTED
    now = timezone.now()
    updates = {"member": member, "status": status, "updated_at": now}
    if not submitted:
        updates["accepted_at"] = now
    EventInvitation.objects.filter(event=event, email__in=normalized).exclude(
        status=EventInvitation.Status.SUBMITTED
    ).update(**updates)


def send_event_reminders(event: Event, *, force: bool = False) -> int:
    if not event.reminders_enabled:
        return 0
    invitations = event.invitations.exclude(status=EventInvitation.Status.SUBMITTED)
    if not force:
        invitations = invitations.filter(reminder_sent_at__isnull=True)
    count = 0
    for invitation in invitations.select_related("event"):
        send_reminder_email(invitation)
        count += 1
    return count


def send_due_event_reminders(*, window_minutes: int) -> int:
    now = timezone.now()
    window_end = now + timedelta(minutes=window_minutes)
    count = 0
    events = Event.objects.filter(
        reminders_enabled=True,
        response_deadline__isnull=False,
        response_deadline__gt=now,
    )
    for event in events:
        reminder_at = event.response_deadline - timedelta(hours=event.reminder_hours_before)
        if reminder_at <= window_end:
            count += send_event_reminders(event, force=False)
    return count
