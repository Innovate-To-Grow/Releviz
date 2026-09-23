from __future__ import annotations

from django.db import transaction


@transaction.atomic
def delete_member_account(*, member) -> None:
    """Permanently delete the member and invalidate affected event results."""

    from apps.scheduling.models import Event, EventResultInvalidation, Participant
    from apps.scheduling.services.managed_members import (
        delete_organizer_managed_members,
        organizer_managed_member_ids,
    )

    affected_event_ids = list(
        Participant.objects.filter(member_id=member.pk)
        .order_by()
        .values_list("event_id", flat=True)
        .distinct()
    )
    # The organizer's events cascade away with the account; the identity-less
    # members behind their organizer-managed people would otherwise linger.
    managed_member_ids = organizer_managed_member_ids(
        Participant.objects.filter(event__organizer_id=member.pk)
    )
    member.delete()
    delete_organizer_managed_members(managed_member_ids)
    remaining_event_ids = Event.objects.filter(pk__in=affected_event_ids).values_list(
        "pk", flat=True
    )
    EventResultInvalidation.objects.bulk_create(
        [EventResultInvalidation(event_id=event_id) for event_id in remaining_event_ids]
    )
