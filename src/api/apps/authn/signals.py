"""
Signal handlers that fire member-to-Google-Sheet sync on member-related writes.

Wires `post_save` and `post_delete` on Member, ContactEmail, and ContactPhone
to `schedule_member_sync()`, deferred via `transaction.on_commit` so the sheet
sees only committed state.

`schedule_member_sync()` is itself a no-op when the config is disabled, so
these receivers are safe to leave registered unconditionally.
"""

from django.db import transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from .models import ContactEmail, ContactPhone, Member


def _schedule():
    from .services.members.sheet_sync import schedule_member_sync

    schedule_member_sync()


@receiver([post_save, post_delete], sender=Member)
@receiver([post_save, post_delete], sender=ContactEmail)
@receiver([post_save, post_delete], sender=ContactPhone)
# noinspection PyUnusedLocal
def schedule_member_sync_on_change(sender, **kwargs):
    from apps.core.services.background_jobs import jobs_enabled

    if jobs_enabled():
        # A direct insert participates in any surrounding transaction, giving
        # account mutations and their outbox row one commit boundary.
        _schedule()
    else:
        transaction.on_commit(_schedule, robust=True)
