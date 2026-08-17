"""Invitation lifecycle status transitions driven by participant activity."""

from django.db import transaction
from django.utils import timezone

from apps.scheduling.models import Event, EventInvitation

from .addresses import member_invitation_emails


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


@transaction.atomic
def mark_invitation_for_member(
    *,
    event: Event,
    member,
    submitted: bool = False,
    draft_saved: bool = False,
) -> None:
    normalized = member_invitation_emails(member)
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
    normalized = member_invitation_emails(member)
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
