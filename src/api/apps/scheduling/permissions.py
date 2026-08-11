from __future__ import annotations

from apps.authn.models import ContactEmail
from apps.scheduling.aggregation import (
    participant_has_valid_submission,
    participant_is_excluded,
)


def canonical_view_permission(event) -> str:
    if event.participant_view_permission == "all":
        return "all_after_submit"
    return event.participant_view_permission


def participant_for_user(event, user):
    return event.participants.select_related("event", "member").filter(member_id=user.pk).first()


def verified_invitation_emails(user) -> set[str]:
    """Return normalized addresses the authenticated member has proved they own."""

    emails = {
        str(email).strip().lower()
        for email in ContactEmail.objects.filter(member=user, verified=True).values_list(
            "email_address",
            flat=True,
        )
        if email
    }
    # ``Member.email`` is retained for legacy identities. Only use it when it is
    # also represented by a verified ContactEmail so an unverified profile value
    # cannot satisfy an invite-only roster check.
    member_email = str(getattr(user, "email", "") or "").strip().lower()
    if (
        member_email
        and ContactEmail.objects.filter(
            member=user,
            email_address__iexact=member_email,
            verified=True,
        ).exists()
    ):
        emails.add(member_email)
    return emails


def has_event_invitation(event, user) -> bool:
    if event.invitations.filter(member_id=user.pk).exists():
        return True
    emails = verified_invitation_emails(user)
    return bool(emails) and event.invitations.filter(email__in=emails).exists()


def can_access_event(event, user) -> bool:
    """Authorize event detail without leaking invite-only event metadata."""

    if event.organizer_id == user.pk:
        return True
    if event.participants.filter(member_id=user.pk, hidden=False).exists():
        return True
    if getattr(event, "access_mode", "open_link") == "open_link":
        return True
    return has_event_invitation(event, user)


def can_join_event(event, user) -> bool:
    if event.organizer_id == user.pk:
        return True
    if event.participants.filter(member_id=user.pk).exists():
        return True
    if getattr(event, "access_mode", "open_link") == "open_link":
        return True
    return has_event_invitation(event, user)


def weight_for_participant(event, participant):
    return event.weights.filter(participant=participant).first()


def can_view_event_results(event, user) -> bool:
    if event.organizer_id == user.pk:
        return True
    participant = participant_for_user(event, user)
    if participant is None:
        return False
    weight = weight_for_participant(event, participant)
    if participant_is_excluded(participant, weight):
        return False
    permission = canonical_view_permission(event)
    if permission == "realtime":
        return True
    return permission == "all_after_submit" and participant_has_valid_submission(
        participant,
        event,
    )


def visible_participants_for_user(event, user, *, include_hidden: bool = False):
    participants = event.participants.select_related("event", "member").all()
    if event.organizer_id == user.pk:
        return list(participants if include_hidden else participants.filter(hidden=False))

    own_participant = participant_for_user(event, user)
    if own_participant is None:
        return None
    own_weight = weight_for_participant(event, own_participant)
    permission = canonical_view_permission(event)
    can_view_shared = not participant_is_excluded(own_participant, own_weight) and (
        permission == "realtime"
        or (
            permission == "all_after_submit"
            and participant_has_valid_submission(own_participant, event)
        )
    )
    if not can_view_shared:
        return [own_participant]

    weights = {weight.participant_id: weight for weight in event.weights.all()}
    visible = []
    for participant in participants.filter(hidden=False):
        if participant.pk == own_participant.pk:
            visible.append(participant)
            continue
        if participant_is_excluded(participant, weights.get(participant.pk)):
            continue
        if participant_has_valid_submission(participant, event):
            visible.append(participant)
    return visible
