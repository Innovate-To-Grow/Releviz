"""Lifecycle of the identity-less members behind organizer-managed people."""

from django.contrib.auth import get_user_model


def organizer_managed_member_ids(participants) -> list:
    """Backing member ids of the organizer-managed rows in ``participants``.

    Collect them before the rows are deleted: the participation is the only
    thing that ties such a member to its event.
    """

    return list(
        participants.filter(organizer_managed=True).order_by().values_list("member_id", flat=True)
    )


def delete_organizer_managed_members(member_ids) -> None:
    """Remove members that existed only for roster rows that are now gone.

    They have no contact email, no usable password and no other participation,
    so nothing else references them once their row is deleted.
    """

    if member_ids:
        get_user_model().objects.filter(pk__in=member_ids).delete()
