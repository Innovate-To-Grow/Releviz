"""Who may access, join, and read the results of an event."""

from __future__ import annotations

from apps.authn.models import ContactEmail


def canonical_view_permission(event) -> str:
    """Normalize the stored setting (a legacy ``all`` means ``all_after_submit``).

    The value is kept for API compatibility only: group availability is the
    organizer's view, and no setting widens it to participants.
    """

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
    """Only the organizer sees group availability.

    Participants submit their own calendar and never see anyone else's, so
    ``participant_view_permission`` does not grant access to results.
    """

    return event.organizer_id == user.pk


def visible_participants_for_user(event, user, *, include_hidden: bool = False):
    """The organizer sees the roster; a participant sees only themselves.

    Returns ``None`` when the user has not joined the event.
    """

    participants = event.participants.select_related("event", "member").all()
    if event.organizer_id == user.pk:
        return list(participants if include_hidden else participants.filter(hidden=False))

    own_participant = participant_for_user(event, user)
    if own_participant is None:
        return None
    return [own_participant]
