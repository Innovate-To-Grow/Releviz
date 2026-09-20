"""API payloads for participants and their weights."""

from apps.scheduling.services.roster_groups import format_group_cell

_INVITATION_NOT_PROVIDED = object()


def participant_memberships(participant) -> dict:
    """The group keys shared by every participant payload.

    ``group`` is the cell form (``"ALL; A; B"``, ``""`` when none) so a single
    group still round-trips as its plain name; ``groups`` lists the explicit
    memberships in name order. Reads ``participant.groups`` (one query unless
    prefetched).
    """

    groups = list(participant.groups.all())
    return {
        "group": format_group_cell(participant.all_groups, [group.name for group in groups]),
        "groups": [{"id": group.pk, "name": group.name} for group in groups],
        "allGroups": participant.all_groups,
    }


def api_participant(
    participant,
    *,
    organizer_private=False,
    invitation=_INVITATION_NOT_PROVIDED,
) -> dict:
    memberships = participant_memberships(participant)
    data = {
        "id": str(participant.member_id),
        "user_id": str(participant.member_id),
        "event_id": str(participant.event.event_id),
        "name": participant.participant_name,
        "availabilityInperson": participant.availability_inperson,
        "availabilityVirtual": participant.availability_virtual,
        "submitted": 1 if participant.submitted else 0,
        "hidden": 1 if participant.hidden else 0,
        "group_name": memberships["group"] or None,
        "groups": memberships["groups"],
        "allGroups": memberships["allGroups"],
        "sort_order": participant.sort_order,
        "version": participant.version,
        "created_at": participant.created_at.isoformat(),
    }
    if not organizer_private:
        return data

    member = participant.member
    member_email = str(member.email or "").strip().lower()
    if not member_email:
        member_email = member.get_primary_email().strip().lower()
    if invitation is _INVITATION_NOT_PROVIDED:
        invitation = (
            participant.event.invitations.filter(member_id=participant.member_id)
            .order_by("-created_at")
            .first()
        )
        if invitation is None:
            if member_email:
                invitation = participant.event.invitations.filter(
                    email__iexact=member_email,
                ).first()

    private_email = (
        str(invitation.email or "").strip().lower() if invitation is not None else member_email
    )

    account_access = getattr(member, "access_level", "full")
    if participant.submitted or (invitation is not None and invitation.status == "submitted"):
        invitation_status = "submitted"
    elif invitation is None or invitation.first_sent_at is None:
        invitation_status = "not_sent"
    elif invitation.opened_at is not None or invitation.status in {
        "opened",
        "joined",
        "draft_saved",
    }:
        invitation_status = "opened"
    else:
        invitation_status = "invited"

    data.update(
        {
            "accountAccess": account_access,
            "email": private_email,
            "invitationStatus": invitation_status,
            "canOrganizerEditAvailability": account_access == "temporary",
        }
    )
    return data


def api_weight(weight) -> dict:
    return {
        "participant_id": str(weight.participant.member_id),
        "participant_name": weight.participant.participant_name,
        "weight": float(weight.weight),
        "included": 1 if weight.included else 0,
    }
