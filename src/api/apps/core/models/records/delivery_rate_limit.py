from django.db import models
from django.utils import timezone


class DeliveryRateLimit(models.Model):
    """Shared next-send slot for a provider across every worker process."""

    provider = models.CharField(max_length=32, unique=True)
    next_available_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Delivery Rate Limit"
        verbose_name_plural = "Delivery Rate Limits"

    def __str__(self):
        return f"{self.provider}: {self.next_available_at.isoformat()}"
