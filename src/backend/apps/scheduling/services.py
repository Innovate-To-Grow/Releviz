from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import UTC, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.messaging.email_templates import render_branded_email
from apps.messaging.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.messaging.services import EmailAttachment, enqueue_email_job, frontend_url
from apps.scheduling.lifecycle import event_configuration_write_error, response_write_error
from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent
from apps.scheduling.utils import default_availability

security_logger = logging.getLogger("releviz.security")


class EventEmailRequestError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class ManagedParticipantError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


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
        .filter(email_address__iexact=email, member__is_active=True)
        .first()
    )
    if contact is None:
        return None
    if contact.verified or getattr(contact.member, "access_level", "full") == "temporary":
        return contact.member
    return None


@transaction.atomic
def create_or_reuse_managed_participant(*, event: Event, organizer, name: str, email: str):
    """Create an event participant without sending an invitation.

    Email is the global identity key. Existing members are reused, while a new
    identity is created as a passwordless, unverified temporary member.
    """

    event = Event.objects.select_for_update().get(pk=event.pk)
    if event.organizer_id != organizer.pk:
        raise ManagedParticipantError(
            "Only the organizer can create managed participants.",
            status_code=403,
        )
    write_error = None if event.status == Event.Status.DRAFT else response_write_error(event)
    if write_error:
        raise ManagedParticipantError(write_error, status_code=409)

    normalized_name = str(name or "").strip()
    normalized_email = str(email or "").strip().lower()
    if not normalized_name:
        raise ManagedParticipantError("Name is required.")
    if len(normalized_name) > 100:
        raise ManagedParticipantError("Name is too long (max 100).")
    if len(normalized_email) > 254:
        raise ManagedParticipantError("Email is too long (max 254).")
    try:
        validate_email(normalized_email)
    except ValidationError as exc:
        raise ManagedParticipantError("Enter a valid email address.") from exc

    contact = (
        ContactEmail.objects.select_for_update(of=("self",))
        .select_related("member")
        .filter(email_address__iexact=normalized_email)
        .first()
    )

    def create_temporary_member():
        Member = get_user_model()
        candidate = Member(
            email=normalized_email,
            first_name=normalized_name,
            is_active=True,
            access_level="temporary",
        )
        candidate.set_unusable_password()
        candidate.save()
        return candidate

    def claim_orphan_contact(orphan, candidate):
        orphan.member = candidate
        orphan.email_type = "primary"
        orphan.verified = False
        orphan.save(update_fields=["member", "email_type", "verified", "updated_at"])

    member_created = False
    if contact is None:
        candidate = create_temporary_member()
        contact, contact_created = ContactEmail.objects.get_or_create(
            email_address=normalized_email,
            defaults={
                "member": candidate,
                "email_type": "primary",
                "verified": False,
            },
        )
        if contact_created:
            member = candidate
            member_created = True
        elif contact.member_id is None:
            claim_orphan_contact(contact, candidate)
            member = candidate
            member_created = True
        else:
            member = contact.member
            candidate.delete()
    elif contact.member_id is None:
        member = create_temporary_member()
        claim_orphan_contact(contact, member)
        member_created = True
    else:
        member = contact.member

    if (
        contact.member_id is not None
        and getattr(member, "access_level", "full") == "full"
        and not contact.verified
    ):
        raise ManagedParticipantError(
            "Unable to create a participant with this email address.",
            status_code=409,
        )

    participant, participant_created = Participant.objects.get_or_create(
        event=event,
        member=member,
        defaults={
            "participant_name": normalized_name,
            "availability_inperson": default_availability(event),
            "availability_virtual": default_availability(event),
        },
    )
    UserEvent.objects.get_or_create(member=member, event=event, role="participant")
    invitation, invitation_created = EventInvitation.objects.get_or_create(
        event=event,
        email=normalized_email,
        defaults={
            "member": member,
            "invited_by": organizer,
        },
    )
    invitation_updates = []
    if invitation.member_id != member.pk:
        invitation.member = member
        invitation_updates.append("member")
    if invitation.invited_by_id is None:
        invitation.invited_by = organizer
        invitation_updates.append("invited_by")
    if invitation_updates:
        invitation.save(update_fields=[*invitation_updates, "updated_at"])

    security_logger.info(
        "managed_participant_created" if participant_created else "managed_participant_reused",
        extra={
            "event_id": str(event.pk),
            "organizer_id": str(organizer.pk),
            "member_id": str(member.pk),
            "member_created": member_created,
            "invitation_created": invitation_created,
            "account_access": getattr(member, "access_level", "full"),
        },
    )
    return {
        "participant": participant,
        "invitation": invitation,
        "participantCreated": participant_created,
        "memberCreated": member_created,
    }


def api_invitation(invitation: EventInvitation) -> dict:
    status_label = dict(EventInvitation.Status.choices).get(
        invitation.status,
        invitation.status.replace("_", " ").title(),
    )
    return {
        "id": invitation.pk,
        "email": invitation.email,
        "memberId": str(invitation.member_id) if invitation.member_id else None,
        "status": invitation.status,
        "statusLabel": status_label,
        "firstSentAt": (invitation.first_sent_at.isoformat() if invitation.first_sent_at else None),
        "lastSentAt": invitation.last_sent_at.isoformat() if invitation.last_sent_at else None,
        "reminderSentAt": invitation.reminder_sent_at.isoformat()
        if invitation.reminder_sent_at
        else None,
        "acceptedAt": invitation.accepted_at.isoformat() if invitation.accepted_at else None,
        "openedAt": invitation.opened_at.isoformat() if invitation.opened_at else None,
        "joinedAt": invitation.joined_at.isoformat() if invitation.joined_at else None,
        "draftSavedAt": (
            invitation.draft_saved_at.isoformat() if invitation.draft_saved_at else None
        ),
        "submittedAt": invitation.submitted_at.isoformat() if invitation.submitted_at else None,
        "awaitingReminder": bool(
            invitation.event.reminders_enabled
            and invitation.status != EventInvitation.Status.SUBMITTED
            and invitation.last_sent_at
            and not invitation.reminder_sent_at
        ),
        "customMessage": invitation.custom_message,
    }


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
    organizer_email = event.organizer.get_primary_contact_email()
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


def _request_fingerprint(payload: dict) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _email_content_fingerprint(
    *,
    subject: str,
    body: str,
    html_body: str,
    attachments: list[EmailAttachment],
) -> str:
    return _request_fingerprint(
        {
            "subject": subject,
            "body": body,
            "htmlBody": html_body,
            "attachments": [
                {
                    "filename": attachment.filename,
                    "content": attachment.content,
                    "mimetype": attachment.mimetype,
                }
                for attachment in attachments
            ],
        }
    )


def _event_email_parts(
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


def _enqueue_invitation_job(
    invitation: EventInvitation,
    *,
    request_key="",
) -> tuple[EmailDeliveryJob, bool]:
    event = invitation.event
    subject, body, html_body, attachments = _event_email_parts(invitation, reminder=False)
    content_fingerprint = _email_content_fingerprint(
        subject=subject,
        body=body,
        html_body=html_body,
        attachments=attachments,
    )
    delivery_fingerprint = hashlib.sha256(
        f"{content_fingerprint}:{request_key}".encode()
    ).hexdigest()
    return enqueue_email_job(
        idempotency_key=(f"invitation:{event.event_id}:{invitation.pk}:{delivery_fingerprint}"),
        message_type=EmailMessageLog.MessageType.INVITATION,
        recipient=invitation.email,
        subject=subject,
        body=body,
        html_body=html_body,
        attachments=attachments,
        message_id=(
            f"<invitation-{event.event_id}-{invitation.pk}-"
            f"{delivery_fingerprint[:16]}@releviz.local>"
        ),
        event=event,
        invitation=invitation,
    )


def _reminder_cycle(event: Event) -> str:
    deadline = event.response_deadline.isoformat() if event.response_deadline else "no-deadline"
    return hashlib.sha256(deadline.encode()).hexdigest()[:24]


def _enqueue_reminder_job(invitation: EventInvitation) -> tuple[EmailDeliveryJob, bool]:
    event = invitation.event
    subject, body, html_body, attachments = _event_email_parts(invitation, reminder=True)
    cycle = _reminder_cycle(event)
    content_fingerprint = _email_content_fingerprint(
        subject=subject,
        body=body,
        html_body=html_body,
        attachments=attachments,
    )
    return enqueue_email_job(
        idempotency_key=(
            f"reminder:{event.event_id}:{invitation.pk}:{cycle}:{content_fingerprint}"
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


def _request_result(
    request_record: EmailDeliveryRequest,
    *,
    event: Event,
    idempotent: bool,
) -> dict:
    jobs = list(
        request_record.jobs.select_related("invitation").order_by("recipient", "created_at")
    )
    invitation_ids = request_record.jobs.exclude(invitation_id__isnull=True).values_list(
        "invitation_id",
        flat=True,
    )
    return {
        "event": event,
        "request": request_record,
        "jobs": jobs,
        "invitations": list(
            EventInvitation.objects.filter(pk__in=invitation_ids).order_by("email")
        ),
        "createdJobCount": request_record.created_job_count,
        "idempotent": idempotent,
    }


@transaction.atomic
def upsert_and_send_invitations(
    *,
    event: Event,
    emails: list[str],
    invited_by,
    idempotency_key,
    message: str = "",
) -> dict:
    event = Event.objects.select_for_update().get(pk=event.pk)
    if event.organizer_id != invited_by.pk:
        raise EventEmailRequestError(
            "Only the organizer can manage invitations.",
            status_code=403,
        )
    write_error = event_configuration_write_error(event)
    if write_error:
        raise EventEmailRequestError(write_error, status_code=409)

    fingerprint = _request_fingerprint(
        {
            "emails": sorted(emails),
            "message": message,
        }
    )
    previous = (
        EmailDeliveryRequest.objects.filter(
            event=event,
            operation=EmailDeliveryRequest.Operation.INVITATION,
            idempotency_key=idempotency_key,
        )
        .prefetch_related("jobs__invitation")
        .first()
    )
    if previous is not None:
        if previous.request_fingerprint != fingerprint:
            security_logger.warning(
                "event_email_idempotency_conflict",
                extra={
                    "event_id": str(event.pk),
                    "operation": EmailDeliveryRequest.Operation.INVITATION,
                    "requested_by": str(invited_by.pk),
                },
            )
            raise EventEmailRequestError(
                "This idempotency key was already used with different invitation details.",
                status_code=409,
            )
        return _request_result(previous, event=event, idempotent=True)

    existing_emails = set(event.invitations.values_list("email", flat=True))
    new_recipient_count = len(set(emails) - existing_emails)
    maximum = settings.INVITATION_MAX_EVENT_RECIPIENTS
    if len(existing_emails) + new_recipient_count > maximum:
        raise EventEmailRequestError(
            f"An event can have at most {maximum} invitation recipients.",
        )

    resolved_members = {email: resolve_invited_member(email) for email in emails}
    temporary_member_ids = {
        member.pk
        for member in resolved_members.values()
        if member is not None and getattr(member, "access_level", "full") == "temporary"
    }
    participant_member_ids = set(
        Participant.objects.filter(
            event=event,
            member_id__in=temporary_member_ids,
        ).values_list("member_id", flat=True)
    )
    for email, member in resolved_members.items():
        if member is not None and member.pk in temporary_member_ids - participant_member_ids:
            raise EventEmailRequestError(
                (
                    f"Temporary participant {email} must be added with Create person "
                    "before sending an access link."
                ),
                status_code=409,
            )

    existing_invitations = {
        invitation.email: invitation
        for invitation in EventInvitation.objects.select_related("member").filter(
            event=event,
            email__in=emails,
            member__isnull=False,
        )
    }
    existing_invitation_member_ids = {
        invitation.member_id for invitation in existing_invitations.values()
    }
    participant_member_ids.update(
        Participant.objects.filter(
            event=event,
            member_id__in=existing_invitation_member_ids,
        ).values_list("member_id", flat=True)
    )

    jobs = []
    created_job_count = 0
    for email in emails:
        member = resolved_members[email]
        existing_invitation = existing_invitations.get(email)
        if (
            member is None
            and existing_invitation is not None
            and existing_invitation.member_id in participant_member_ids
        ):
            member = existing_invitation.member
        invitation, _ = EventInvitation.objects.update_or_create(
            event=event,
            email=email,
            defaults={
                "member": member,
                "invited_by": invited_by,
                "custom_message": message,
            },
        )
        job, created = _enqueue_invitation_job(
            invitation,
            request_key=str(idempotency_key),
        )
        jobs.append(job)
        created_job_count += int(created)

    request_record = EmailDeliveryRequest.objects.create(
        event=event,
        requested_by=invited_by,
        operation=EmailDeliveryRequest.Operation.INVITATION,
        idempotency_key=idempotency_key,
        request_fingerprint=fingerprint,
        recipient_count=len(jobs),
        created_job_count=created_job_count,
    )
    request_record.jobs.add(*jobs)
    security_logger.info(
        "event_email_request_created",
        extra={
            "event_id": str(event.pk),
            "operation": EmailDeliveryRequest.Operation.INVITATION,
            "requested_by": str(invited_by.pk),
            "recipient_count": len(jobs),
            "created_job_count": created_job_count,
        },
    )
    return _request_result(request_record, event=event, idempotent=False)


@transaction.atomic
def enqueue_manual_reminders(
    *,
    event: Event,
    requested_by,
    idempotency_key,
) -> dict:
    event = Event.objects.select_for_update().get(pk=event.pk)
    if event.organizer_id != requested_by.pk:
        raise EventEmailRequestError(
            "Only the organizer can send reminders.",
            status_code=403,
        )
    write_error = event_configuration_write_error(event)
    if write_error:
        raise EventEmailRequestError(write_error, status_code=409)

    fingerprint = _request_fingerprint(
        {
            "operation": EmailDeliveryRequest.Operation.REMINDER,
            "cycle": _reminder_cycle(event),
        }
    )
    previous = (
        EmailDeliveryRequest.objects.filter(
            event=event,
            operation=EmailDeliveryRequest.Operation.REMINDER,
            idempotency_key=idempotency_key,
        )
        .prefetch_related("jobs__invitation")
        .first()
    )
    if previous is not None:
        if previous.request_fingerprint != fingerprint:
            security_logger.warning(
                "event_email_idempotency_conflict",
                extra={
                    "event_id": str(event.pk),
                    "operation": EmailDeliveryRequest.Operation.REMINDER,
                    "requested_by": str(requested_by.pk),
                },
            )
            raise EventEmailRequestError(
                "This idempotency key belongs to an earlier reminder cycle.",
                status_code=409,
            )
        return _request_result(previous, event=event, idempotent=True)

    invitations = list(
        event.invitations.exclude(status=EventInvitation.Status.SUBMITTED)
        .select_related("event")
        .order_by("email")
    )
    if not event.reminders_enabled:
        invitations = []
    maximum = settings.REMINDER_MAX_RECIPIENTS
    if len(invitations) > maximum:
        raise EventEmailRequestError(
            f"A reminder request can include at most {maximum} recipients.",
        )

    jobs = []
    created_job_count = 0
    for invitation in invitations:
        job, created = _enqueue_reminder_job(invitation)
        jobs.append(job)
        created_job_count += int(created)

    request_record = EmailDeliveryRequest.objects.create(
        event=event,
        requested_by=requested_by,
        operation=EmailDeliveryRequest.Operation.REMINDER,
        idempotency_key=idempotency_key,
        request_fingerprint=fingerprint,
        recipient_count=len(jobs),
        created_job_count=created_job_count,
    )
    request_record.jobs.add(*jobs)
    security_logger.info(
        "event_email_request_created",
        extra={
            "event_id": str(event.pk),
            "operation": EmailDeliveryRequest.Operation.REMINDER,
            "requested_by": str(requested_by.pk),
            "recipient_count": len(jobs),
            "created_job_count": created_job_count,
        },
    )
    return _request_result(request_record, event=event, idempotent=False)


@transaction.atomic
def mark_invitation_opened(*, event_code: str, access_token) -> bool:
    invitation = (
        EventInvitation.objects.select_for_update()
        .select_related("event")
        .filter(event__code=event_code, access_token=access_token)
        .first()
    )
    if invitation is None:
        return False
    now = timezone.now()
    update_fields = []
    if invitation.opened_at is None:
        invitation.opened_at = now
        update_fields.append("opened_at")
    if invitation.status == EventInvitation.Status.INVITED:
        invitation.status = EventInvitation.Status.OPENED
        update_fields.append("status")
    if update_fields:
        invitation.updated_at = now
        update_fields.append("updated_at")
        invitation.save(update_fields=update_fields)
    return True


def _member_invitation_emails(member) -> set[str]:
    emails = list(
        ContactEmail.objects.filter(member=member, verified=True).values_list(
            "email_address",
            flat=True,
        )
    )
    if member.email:
        emails.append(member.email)
    return {email.strip().lower() for email in emails if email}


@transaction.atomic
def mark_invitation_for_member(
    *,
    event: Event,
    member,
    submitted: bool = False,
    draft_saved: bool = False,
) -> None:
    normalized = _member_invitation_emails(member)
    if not normalized:
        return

    target_status = (
        EventInvitation.Status.SUBMITTED
        if submitted
        else EventInvitation.Status.DRAFT_SAVED
        if draft_saved
        else EventInvitation.Status.JOINED
    )
    status_order = {
        EventInvitation.Status.INVITED: 0,
        EventInvitation.Status.OPENED: 1,
        "accepted": 2,
        EventInvitation.Status.JOINED: 2,
        EventInvitation.Status.DRAFT_SAVED: 3,
        EventInvitation.Status.SUBMITTED: 4,
    }
    now = timezone.now()
    invitations = EventInvitation.objects.select_for_update().filter(
        event=event,
        email__in=normalized,
    )
    for invitation in invitations:
        update_fields = []
        if invitation.member_id != member.pk:
            invitation.member = member
            update_fields.append("member")
        if status_order.get(invitation.status, 0) < status_order[target_status]:
            invitation.status = target_status
            update_fields.append("status")
        if invitation.accepted_at is None:
            invitation.accepted_at = now
            update_fields.append("accepted_at")
        if invitation.joined_at is None:
            invitation.joined_at = now
            update_fields.append("joined_at")
        if draft_saved:
            invitation.draft_saved_at = now
            update_fields.append("draft_saved_at")
        if submitted and invitation.submitted_at is None:
            invitation.submitted_at = now
            update_fields.append("submitted_at")
        if update_fields:
            invitation.updated_at = now
            update_fields.append("updated_at")
            invitation.save(update_fields=update_fields)


@transaction.atomic
def mark_invitation_response_withdrawn(*, event: Event, member) -> None:
    normalized = _member_invitation_emails(member)
    now = timezone.now()
    EventInvitation.objects.select_for_update().filter(
        event=event,
        email__in=normalized,
    ).update(
        member=member,
        status=EventInvitation.Status.DRAFT_SAVED,
        draft_saved_at=now,
        updated_at=now,
    )


@transaction.atomic
def send_event_reminders(event: Event, *, force: bool = False) -> int:
    if not event.reminders_enabled:
        return 0
    event = Event.objects.select_for_update().get(pk=event.pk)
    invitations = event.invitations.exclude(status=EventInvitation.Status.SUBMITTED)
    if not force:
        invitations = invitations.filter(reminder_sent_at__isnull=True)
    count = 0
    for invitation in invitations.select_related("event"):
        _job, created = _enqueue_reminder_job(invitation)
        count += int(created)
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
