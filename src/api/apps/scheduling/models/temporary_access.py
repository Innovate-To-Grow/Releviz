"""Event-scoped session credential for temporary participants."""

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import TimestampedModel

from .participants.invitation import EventInvitation
from .participants.participant import Participant


class TemporaryEventSession(TimestampedModel):
    """An opaque, event-scoped session for a temporary participant.

    This credential is deliberately separate from ``AuthSession`` and never
    produces a JWT. The browser cookie contains the session UUID and a random
    secret; only the SHA-256 digest of that secret is persisted.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="temporary_event_sessions",
    )
    participant = models.ForeignKey(
        Participant,
        on_delete=models.CASCADE,
        related_name="temporary_sessions",
    )
    invitation = models.ForeignKey(
        EventInvitation,
        on_delete=models.CASCADE,
        related_name="temporary_sessions",
    )
    secret_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    last_seen_at = models.DateTimeField(default=timezone.now)
    revoked_at = models.DateTimeField(null=True, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["member", "revoked_at", "expires_at"],
                name="tmp_session_member_exp_idx",
            ),
            models.Index(
                fields=["participant", "revoked_at", "expires_at"],
                name="tmp_session_part_exp_idx",
            ),
            models.Index(fields=["expires_at"], name="tmp_session_expires_idx"),
        ]

    @property
    def active(self) -> bool:
        return self.revoked_at is None and self.expires_at > timezone.now()

    def revoke(self) -> bool:
        if self.revoked_at is not None:
            return False
        self.revoked_at = timezone.now()
        self.save(update_fields=["revoked_at", "updated_at"])
        return True

    def __str__(self) -> str:
        state = "active" if self.active else "revoked/expired"
        return f"{self.member_id} / {self.participant.event.code} [{state}]"
