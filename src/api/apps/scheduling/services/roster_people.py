"""Organizer corrections to one roster entry: removing a person, changing an email.

Both run inside the caller's transaction with the event row already locked
(the roster views lock it first, like every other roster writer).
"""

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.utils import timezone

from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    TemporaryEventSession,
    UserEvent,
)

from .invitations.errors import ManagedParticipantError
from .invitations.managed import check_roster_member_usable, resolve_roster_member
from .managed_members import delete_organizer_managed_members
from .roster_imports.errors import RosterImportError

EMAIL_SENDING_MESSAGE = "An email to this person is being sent right now. Try again in a minute."
EMAIL_LOCKED_MESSAGE = (
    "This person has already signed in or answered, so their email can no longer be "
    "changed. Remove them and add them again if the address is wrong."
)
OWN_ROW_EMAIL_MESSAGE = "Your own email comes from your account settings."
OWN_ADDRESS_MESSAGE = (
    "That is one of your own addresses. Enter this person's own email, or use Add myself "
    "to add yourself as a participant."
)


def email_change_allowed(participant, *, invitation_accepted: bool, has_session: bool) -> bool:
    """Whether the organizer may still point this roster entry at another address.

    Only while the person has never acted on the event: no claim of their own
    response, no accepted invitation, and no temporary link session. The
    organizer's own row takes its address from their account.
    """

    return not (
        participant.member_id == participant.event.organizer_id
        or participant.response_claimed_at is not None
        or invitation_accepted
        or has_session
    )


def _retire_invitations(invitations, now) -> None:
    """Cancel the queued emails of invitations that are about to be deleted.

    A delivery that is already being handed to the provider cannot be pulled
    back, so the change waits for it instead of losing track of it.
    """

    invitation_ids = [invitation.pk for invitation in invitations]
    if not invitation_ids:
        return
    jobs = list(
        EmailDeliveryJob.objects.select_for_update()
        .filter(invitation_id__in=invitation_ids)
        .order_by("pk")
    )
    if any(job.status == EmailDeliveryJob.Status.PROCESSING for job in jobs):
        raise RosterImportError(EMAIL_SENDING_MESSAGE, status_code=409)
    EmailDeliveryJob.objects.filter(
        pk__in=[job.pk for job in jobs],
        status__in=[EmailDeliveryJob.Status.PENDING, EmailDeliveryJob.Status.RETRY],
    ).update(
        status=EmailDeliveryJob.Status.CANCELED,
        last_error="The person was changed on the event's participant list.",
        locked_at=None,
        lock_token=None,
        updated_at=now,
    )


def _member_invitations(event: Event, member_id) -> list:
    return list(
        EventInvitation.objects.select_for_update()
        .filter(event=event, member_id=member_id)
        .order_by("pk")
    )


def remove_participant(*, event: Event, participant: Participant) -> None:
    """Delete one person from the roster with their answers and invitation.

    Their weight, group memberships and link sessions go with the row; queued
    invitation or reminder emails are canceled. A person with no email of
    their own also loses the identity-less member that existed only for them.
    """

    now = timezone.now()
    invitations = _member_invitations(event, participant.member_id)
    _retire_invitations(invitations, now)
    EventInvitation.objects.filter(pk__in=[invitation.pk for invitation in invitations]).delete()
    UserEvent.objects.filter(
        event=event, member_id=participant.member_id, role="participant"
    ).delete()
    managed_member_ids = [participant.member_id] if participant.organizer_managed else []
    participant.delete()
    delete_organizer_managed_members(managed_member_ids)


def _normalized_email(value) -> str:
    email = str(value or "").strip().lower()
    if not email:
        raise RosterImportError("Email is required.")
    if len(email) > 254:
        raise RosterImportError("Email is too long (max 254).")
    try:
        validate_email(email)
    except ValidationError as exc:
        raise RosterImportError("Enter a valid email address.") from exc
    return email


def change_participant_email(*, event: Event, participant: Participant, organizer, email) -> bool:
    """Point a roster entry at another address; True when anything changed.

    The entry moves to the account that owns the new address (a new temporary
    identity when nobody does), keeping its name, groups, weight and any
    schedule the organizer entered. The old invitation and its link are
    deleted and a fresh, unsent one is filed for the new address. A person
    with no email of their own becomes an ordinary invitable person.
    """

    invitations = _member_invitations(event, participant.member_id)
    if not email_change_allowed(
        participant,
        invitation_accepted=any(invitation.accepted_at for invitation in invitations),
        has_session=TemporaryEventSession.objects.filter(participant=participant).exists(),
    ):
        message = (
            OWN_ROW_EMAIL_MESSAGE
            if participant.member_id == event.organizer_id
            else EMAIL_LOCKED_MESSAGE
        )
        raise RosterImportError(message, status_code=409)

    normalized = _normalized_email(email)
    current = invitations[-1].email if invitations else ""
    if not participant.organizer_managed and normalized == current:
        return False
    if organizer.contact_emails.filter(email_address__iexact=normalized).exists():
        raise RosterImportError(OWN_ADDRESS_MESSAGE, status_code=409)

    try:
        member, contact, _created = resolve_roster_member(normalized, participant.participant_name)
        check_roster_member_usable(member, contact)
    except ManagedParticipantError as exc:
        raise RosterImportError(str(exc), status_code=exc.status_code) from exc
    if member.pk != participant.member_id and event.participants.filter(member=member).exists():
        raise RosterImportError(f"{normalized} is already a participant.", status_code=409)

    # A leftover invitation for the new address (someone removed earlier)
    # is replaced too, so the new one starts unsent with a fresh link.
    stale = list(
        EventInvitation.objects.select_for_update()
        .filter(event=event, email=normalized)
        .exclude(pk__in=[invitation.pk for invitation in invitations])
    )
    retiring = [*invitations, *stale]
    remaining = event.invitations.exclude(pk__in=[invitation.pk for invitation in retiring])
    if remaining.count() >= settings.INVITATION_MAX_EVENT_RECIPIENTS:
        raise RosterImportError(
            f"An event can have at most {settings.INVITATION_MAX_EVENT_RECIPIENTS} "
            "invitation recipients.",
            status_code=409,
        )
    _retire_invitations(retiring, timezone.now())
    EventInvitation.objects.filter(pk__in=[invitation.pk for invitation in retiring]).delete()

    previous_member_id = participant.member_id
    was_managed = participant.organizer_managed
    if member.pk != previous_member_id:
        UserEvent.objects.filter(
            event=event, member_id=previous_member_id, role="participant"
        ).delete()
        participant.member = member
    UserEvent.objects.get_or_create(member=member, event=event, role="participant")
    participant.organizer_managed = False
    participant.contact_email = ""
    participant.version += 1
    participant.save(
        update_fields=["member", "organizer_managed", "contact_email", "version", "updated_at"]
    )
    EventInvitation.objects.create(
        event=event, email=normalized, member=member, invited_by=organizer
    )
    if was_managed:
        delete_organizer_managed_members([previous_member_id])
    return True
