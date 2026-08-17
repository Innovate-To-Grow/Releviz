"""Email invitations that grant access to an event."""

import uuid

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event


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
