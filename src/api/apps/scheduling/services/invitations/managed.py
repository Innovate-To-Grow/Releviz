"""Creation and reuse of organizer-managed participants."""

import logging

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction

from apps.authn.models import ContactEmail
from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent
from apps.scheduling.services.availability import default_availability
from apps.scheduling.services.events.lifecycle import response_write_error

from .addresses import normalize_phone, organizer_addresses
from .errors import (
    INACTIVE_ACCOUNT_MESSAGE,
    UNVERIFIED_FULL_ACCOUNT_MESSAGE,
    ManagedParticipantError,
)

security_logger = logging.getLogger("releviz.security")


def _create_or_reuse_organizer_managed_participant(
    *,
    event: Event,
    organizer,
    name: str,
    email: str,
    phone: str,
) -> dict:
    """Create or restore a person whose contact address belongs to the organizer.

    The address stays the organizer's identity: the person is backed by a fresh
    temporary member with no ``ContactEmail`` and an empty ``Member.email``, so
    nothing resolves the shared address to them, and no invitation is ever
    created for them. A blank ``email`` files them under the organizer's primary
    verified address. The reuse key is (event, address, name) under the event lock.
    """

    addresses = organizer_addresses(organizer.pk)
    email = addresses.contact_for(email)
    if email not in addresses.verified:
        raise ManagedParticipantError(
            "Use one of your own verified email addresses for a person you manage."
        )

    participant = (
        Participant.objects.select_related("member")
        .filter(
            event=event,
            organizer_managed=True,
            contact_email=email,
            participant_name__iexact=name,
        )
        .first()
    )
    participant_created = participant is None
    participant_restored = False
    member_created = False
    if participant_created:
        participant_limit = getattr(settings, "EVENT_MAX_PARTICIPANTS", 1000)
        if event.participants.count() >= participant_limit:
            raise ManagedParticipantError(
                f"An event can have at most {participant_limit} participants.",
                status_code=409,
            )
        Member = get_user_model()
        member = Member(
            email="",
            first_name=name,
            is_active=True,
            access_level=Member.AccessLevel.TEMPORARY,
        )
        member.set_unusable_password()
        member.save()
        member_created = True
        participant = Participant.objects.create(
            event=event,
            member=member,
            participant_name=name,
            contact_email=email,
            contact_phone=phone,
            organizer_managed=True,
            availability_inperson=default_availability(event),
            availability_virtual=default_availability(event),
        )
    else:
        member = participant.member
        participant_restored = participant.hidden
        participant_updates = []
        if participant_restored:
            participant.hidden = False
            participant_updates.append("hidden")
            if participant.participant_name != name:
                participant.participant_name = name
                participant_updates.append("participant_name")
            participant.version += 1
            participant_updates.append("version")
        if participant_updates:
            participant.save(update_fields=[*participant_updates, "updated_at"])
    UserEvent.objects.get_or_create(member=member, event=event, role="participant")

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
            "invitation_created": False,
            "account_access": member.access_level,
            "organizer_managed": True,
        },
    )
    return {
        "participant": participant,
        "invitation": None,
        "participantCreated": participant_created,
        "participantRestored": participant_restored,
        "memberCreated": member_created,
    }


def resolve_roster_member(normalized_email: str, normalized_name: str):
    """The member behind a roster address, as ``(member, contact, member_created)``.

    Email is the global identity key: the account that owns the address is
    reused, and an unknown (or orphaned) address gets a fresh passwordless,
    unverified temporary member named ``normalized_name``. The contact row is
    locked.
    """

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
    return member, contact, member_created


def check_roster_member_usable(member, contact) -> None:
    """Refuse addresses whose account cannot take part in an event."""

    if not member.is_active:
        raise ManagedParticipantError(INACTIVE_ACCOUNT_MESSAGE, status_code=409)

    if (
        contact.member_id is not None
        and getattr(member, "access_level", "full") == "full"
        and not contact.verified
    ):
        raise ManagedParticipantError(UNVERIFIED_FULL_ACCOUNT_MESSAGE, status_code=409)


@transaction.atomic
def create_or_reuse_managed_participant(
    *,
    event: Event,
    organizer,
    name: str,
    email: str,
    phone: str = "",
    organizer_managed: bool = False,
):
    """Create an event participant without sending an invitation.

    Email is the global identity key. Existing members are reused, while a new
    identity is created as a passwordless, unverified temporary member. With
    ``organizer_managed`` the address is one of the organizer's own (blank means
    their primary one) and never becomes an identity for the person.
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
    if normalized_email or not organizer_managed:
        try:
            validate_email(normalized_email)
        except ValidationError as exc:
            raise ManagedParticipantError("Enter a valid email address.") from exc
    normalized_phone = normalize_phone(phone)

    if organizer_managed:
        return _create_or_reuse_organizer_managed_participant(
            event=event,
            organizer=organizer,
            name=normalized_name,
            email=normalized_email,
            phone=normalized_phone,
        )
    if organizer.contact_emails.filter(email_address__iexact=normalized_email).exists():
        raise ManagedParticipantError(
            "That is one of your own addresses. Use Add myself to add yourself as a participant, "
            'or check "No email of their own" to add a person you manage.',
            status_code=409,
            error_code="organizer_own_email",
        )

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

    member, contact, member_created = resolve_roster_member(normalized_email, normalized_name)

    participant_exists = event.participants.filter(member=member).exists()
    participant_limit = getattr(settings, "EVENT_MAX_PARTICIPANTS", 1000)
    if not participant_exists and event.participants.count() >= participant_limit:
        raise ManagedParticipantError(
            f"An event can have at most {participant_limit} participants.",
            status_code=409,
        )

    check_roster_member_usable(member, contact)

    participant, participant_created = Participant.objects.get_or_create(
        event=event,
        member=member,
        defaults={
            "participant_name": normalized_name,
            "contact_phone": normalized_phone,
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
            "organizer_managed": False,
        },
    )
    return {
        "participant": participant,
        "invitation": invitation,
        "participantCreated": participant_created,
        "participantRestored": participant_restored,
        "memberCreated": member_created,
    }
