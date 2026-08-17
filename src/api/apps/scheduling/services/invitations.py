"""Invitation records: who is invited to an event and how far they have got.

Sending is a separate concern; see ``apps.scheduling.services.deliveries``.
"""

from __future__ import annotations

import logging
import re

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent
from apps.scheduling.services.lifecycle import response_write_error
from apps.scheduling.services.slots import default_availability

security_logger = logging.getLogger("releviz.security")


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
    write_error = response_write_error(event)
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

    invitation_exists = event.invitations.filter(email__iexact=normalized_email).exists()
    if (
        not invitation_exists
        and event.invitations.count() >= settings.INVITATION_MAX_EVENT_RECIPIENTS
    ):
        raise ManagedParticipantError(
            f"An event can have at most {settings.INVITATION_MAX_EVENT_RECIPIENTS} "
            "invitation recipients.",
            status_code=409,
        )

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

    participant_exists = event.participants.filter(member=member).exists()
    participant_limit = getattr(settings, "EVENT_MAX_PARTICIPANTS", 1000)
    if not participant_exists and event.participants.count() >= participant_limit:
        raise ManagedParticipantError(
            f"An event can have at most {participant_limit} participants.",
            status_code=409,
        )

    if not member.is_active:
        raise ManagedParticipantError(
            "Unable to create a participant with this email address.",
            status_code=409,
        )

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
    participant_restored = not participant_created and participant.hidden
    participant_updates = []
    if participant_restored:
        participant.hidden = False
        participant_updates.append("hidden")
        if participant.participant_name != normalized_name:
            participant.participant_name = normalized_name
            participant_updates.append("participant_name")
        participant.version += 1
        participant_updates.append("version")
    if participant_updates:
        participant.save(update_fields=[*participant_updates, "updated_at"])
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
        (
            "managed_participant_created"
            if participant_created
            else "managed_participant_restored"
            if participant_restored
            else "managed_participant_reused"
        ),
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
        "participantRestored": participant_restored,
        "memberCreated": member_created,
    }


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
