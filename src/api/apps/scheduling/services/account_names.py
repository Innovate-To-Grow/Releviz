"""Participant names that come from the person's own account."""

from django.db.models import F, Q
from django.utils import timezone

from apps.scheduling.models import Participant


def sync_account_participant_names(member) -> int:
    """Give ``member``'s account-named participations the account's current name.

    Those are the rows the organizer may no longer rename (see
    ``organizer_may_edit_response``): the person answers under their own
    account, or it is the organizer's own row, in every event whatever its
    status. A row the organizer still answers for keeps the name the organizer
    gave it, and a temporary identity takes its account's name when it
    upgrades. A renamed row moves to a new version, which the roster digest and
    the live stream pick up; results never show names, so they stay as they
    are. Returns how many rows were renamed.
    """

    if member.access_level == member.AccessLevel.TEMPORARY:
        return 0
    name = member.display_name().strip()[:100]
    if not name:
        return 0
    return (
        Participant.objects.filter(member=member, organizer_managed=False)
        .filter(Q(response_claimed_at__isnull=False) | Q(event__organizer=member))
        .exclude(participant_name=name)
        .update(participant_name=name, version=F("version") + 1, updated_at=timezone.now())
    )
