from __future__ import annotations

from django.db import transaction


@transaction.atomic
def delete_member_account(*, member) -> None:
    """Permanently delete the member and cascade related records."""
    member.delete()
