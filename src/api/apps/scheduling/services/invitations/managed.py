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

from .errors import ManagedParticipantError

security_logger = logging.getLogger("releviz.security")


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
