from __future__ import annotations

from django.db import transaction


@transaction.atomic
def delete_member_account(*, member) -> None:
    """Permanently delete the member and invalidate affected event results."""

    from apps.scheduling.models import Event, EventResultInvalidation, Participant

    affected_event_ids = list(
        Participant.objects.filter(member_id=member.pk)
        .order_by()
        .values_list("event_id", flat=True)
        .distinct()
    )
    member.delete()
    remaining_event_ids = Event.objects.filter(pk__in=affected_event_ids).values_list(
        "pk", flat=True
    )
    EventResultInvalidation.objects.bulk_create(
        [EventResultInvalidation(event_id=event_id) for event_id in remaining_event_ids]
    )
