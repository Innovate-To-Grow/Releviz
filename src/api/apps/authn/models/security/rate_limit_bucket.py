"""Durable, cross-process authentication rate-limit state."""

from django.db import models
from django.utils import timezone

from apps.core.models import TimestampedModel


class AuthRateLimitBucket(TimestampedModel):
    """A shared fixed-window counter keyed by an HMAC, never raw identity data."""

    scope = models.CharField(max_length=64)
    key_hash = models.CharField(max_length=64)
    request_count = models.PositiveIntegerField(default=0)
    window_started_at = models.DateTimeField(default=timezone.now)
    blocked_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["scope", "key_hash"],
                name="unique_auth_rate_limit_bucket",
            )
        ]
        indexes = [
            models.Index(fields=["scope", "blocked_until"]),
            models.Index(fields=["updated_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.scope}:{self.key_hash[:12]} ({self.request_count})"
