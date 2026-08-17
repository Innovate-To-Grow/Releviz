"""Idempotent enqueueing of invitation and reminder delivery requests."""

import hashlib
import logging

from django.conf import settings
from django.db import transaction

from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.mail.services import enqueue_email_job
from apps.scheduling.models import Event, EventInvitation, Participant
from apps.scheduling.services.events.lifecycle import response_write_error
from apps.scheduling.services.fingerprints import email_content_fingerprint, payload_fingerprint

from .addresses import resolve_invited_member
from .errors import EventEmailRequestError
from .managed import create_or_reuse_managed_participant
from .messages import event_email_parts
from .reminders import enqueue_reminder_job, reminder_cycle

security_logger = logging.getLogger("releviz.security")


def _enqueue_invitation_job(
    invitation: EventInvitation,
    *,
    request_key="",
) -> tuple[EmailDeliveryJob, bool]:
    event = invitation.event
    subject, body, html_body, attachments = event_email_parts(invitation, reminder=False)
    content_fingerprint = email_content_fingerprint(
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


def _request_result(
    request_record: EmailDeliveryRequest,
    *,
    event: Event,
    idempotent: bool,
    hydrate: bool = True,
) -> dict:
    jobs = []
    invitations = []
    if hydrate:
        jobs = list(
            request_record.jobs.select_related("invitation").order_by("recipient", "created_at")
        )
        invitation_ids = request_record.jobs.exclude(invitation_id__isnull=True).values_list(
            "invitation_id",
            flat=True,
        )
        invitations = list(EventInvitation.objects.filter(pk__in=invitation_ids).order_by("email"))
    return {
        "event": event,
        "request": request_record,
        "jobs": jobs,
        "invitations": invitations,
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
    hydrate_result: bool = True,
    request_fingerprint: str | None = None,
) -> dict:
    event = Event.objects.select_for_update().get(pk=event.pk)
    if event.organizer_id != invited_by.pk:
        raise EventEmailRequestError(
            "Only the organizer can manage invitations.",
            status_code=403,
        )
    write_error = response_write_error(event)
    if write_error:
        raise EventEmailRequestError(write_error, status_code=409)

    fingerprint = request_fingerprint or payload_fingerprint(
        {
            "emails": sorted(emails),
            "message": message,
        }
    )
    previous_query = EmailDeliveryRequest.objects.filter(
        event=event,
        operation=EmailDeliveryRequest.Operation.INVITATION,
        idempotency_key=idempotency_key,
    )
    if hydrate_result:
        previous_query = previous_query.prefetch_related("jobs__invitation")
    previous = previous_query.first()
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
        return _request_result(
            previous,
            event=event,
            idempotent=True,
            hydrate=hydrate_result,
        )

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
    return _request_result(
        request_record,
        event=event,
        idempotent=False,
        hydrate=hydrate_result,
    )


@transaction.atomic
def create_or_reuse_managed_participant_and_send(
    *,
    event: Event,
    organizer,
    name: str,
    email: str,
    idempotency_key,
) -> dict:
    """Create/restore one roster person and atomically queue their invitation.

    A participant that is already visible is a no-op for a new idempotency key.
    Replaying the original key still returns the original delivery request.
    """

    normalized_name = str(name or "").strip()
    normalized_email = str(email or "").strip().lower()
    managed_fingerprint = payload_fingerprint(
        {
            "operation": "managed_participant",
            "name": normalized_name,
            "email": normalized_email,
        }
    )
    previous = EmailDeliveryRequest.objects.filter(
        event=event,
        operation=EmailDeliveryRequest.Operation.INVITATION,
        idempotency_key=idempotency_key,
    ).first()
    if previous is not None and previous.request_fingerprint != managed_fingerprint:
        raise EventEmailRequestError(
            "This idempotency key was already used with different participant details.",
            status_code=409,
        )

    result = create_or_reuse_managed_participant(
        event=event,
        organizer=organizer,
        name=normalized_name,
        email=normalized_email,
    )
    previous_exists = previous is not None
    should_send = result["participantCreated"] or result["participantRestored"] or previous_exists
    delivery_result = None
    if should_send:
        delivery_result = upsert_and_send_invitations(
            event=event,
            emails=[normalized_email],
            invited_by=organizer,
            idempotency_key=idempotency_key,
            request_fingerprint=managed_fingerprint,
        )
    else:
        request_record = EmailDeliveryRequest.objects.create(
            event=event,
            requested_by=organizer,
            operation=EmailDeliveryRequest.Operation.INVITATION,
            idempotency_key=idempotency_key,
            request_fingerprint=managed_fingerprint,
            recipient_count=0,
            created_job_count=0,
        )
        delivery_result = _request_result(
            request_record,
            event=event,
            idempotent=False,
            hydrate=True,
        )
    result["deliveryResult"] = delivery_result
    return result


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
    write_error = response_write_error(event)
    if write_error:
        raise EventEmailRequestError(write_error, status_code=409)

    fingerprint = payload_fingerprint(
        {
            "operation": EmailDeliveryRequest.Operation.REMINDER,
            "cycle": reminder_cycle(event),
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
        event.invitations.filter(first_sent_at__isnull=False)
        .exclude(status=EventInvitation.Status.SUBMITTED)
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
        job, created = enqueue_reminder_job(invitation)
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
