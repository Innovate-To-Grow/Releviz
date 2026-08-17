"""Invitation records and the event-scoped session issued to a temporary participant."""

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import TimestampedModel
from apps.scheduling.models.events import Event
from apps.scheduling.models.participants import Participant


class EventInvitation(TimestampedModel):
    class Status(models.TextChoices):
        INVITED = "invited", "Invited"
        OPENED = "opened", "Opened"
        JOINED = "joined", "Joined"
        DRAFT_SAVED = "draft_saved", "Draft saved"
        SUBMITTED = "submitted", "Submitted"

    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField()
    access_token = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="event_invitations",
    )
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sent_event_invitations",
    )
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.INVITED)
    first_sent_at = models.DateTimeField(null=True, blank=True)
    last_sent_at = models.DateTimeField(null=True, blank=True)
    reminder_sent_at = models.DateTimeField(null=True, blank=True)
    accepted_at = models.DateTimeField(null=True, blank=True)
    opened_at = models.DateTimeField(null=True, blank=True)
    joined_at = models.DateTimeField(null=True, blank=True)
    draft_saved_at = models.DateTimeField(null=True, blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    custom_message = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["email"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "email"],
                name="one_invitation_per_event_email",
            )
        ]
        indexes = [
            models.Index(fields=["email"]),
            models.Index(fields=["status"]),
            models.Index(fields=["first_sent_at"]),
            models.Index(fields=["last_sent_at"]),
            models.Index(fields=["reminder_sent_at"]),
        ]

    def save(self, *args, **kwargs):
        self.email = self.email.strip().lower()
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"{self.email} invited to {self.event.code} [{self.status}]"


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
