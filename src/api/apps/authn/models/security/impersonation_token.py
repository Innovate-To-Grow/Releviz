"""Admin-initiated impersonation tokens for logging in as a member."""

import secrets
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import ProjectControlModel


def default_expiry():
    return timezone.now() + timedelta(minutes=5)


class ImpersonationToken(ProjectControlModel):
    """Short-lived, one-time token that lets an admin log in as a member on the frontend."""

    token = models.CharField(max_length=128, unique=True, db_index=True, editable=False)
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="impersonation_tokens",
        help_text="The member being impersonated.",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="impersonation_tokens_created",
        help_text="The admin who initiated the impersonation.",
    )
    expires_at = models.DateTimeField(default=default_expiry)
    is_used = models.BooleanField(default=False)
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        status = "used" if self.is_used else ("expired" if self.is_expired else "active")
        return f"Impersonate {self.member} by {self.created_by} ({status})"

    @property
    def is_expired(self):
        return timezone.now() >= self.expires_at

    @property
    def is_valid(self):
        return not self.is_used and not self.is_expired

    def mark_used(self):
        self.is_used = True
        self.used_at = timezone.now()
        self.save(update_fields=["is_used", "used_at", "updated_at"])

    def try_mark_used(self) -> bool:
        """Atomically consume this token, returning whether this caller won."""

        now = timezone.now()
        updated = (
            type(self)
            .objects.filter(
                pk=self.pk,
                is_used=False,
                expires_at__gt=now,
            )
            .update(
                is_used=True,
                used_at=now,
                updated_at=now,
            )
        )
        if updated:
            self.is_used = True
            self.used_at = now
            return True
        return False

    @staticmethod
    def generate_token():
        return secrets.token_urlsafe(48)
