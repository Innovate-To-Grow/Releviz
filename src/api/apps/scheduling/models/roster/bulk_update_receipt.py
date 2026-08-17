"""Idempotency receipt for bulk roster edits."""

from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event


class RosterBulkUpdateReceipt(TimestampedModel):
    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="roster_bulk_update_receipts",
    )
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    matched_count = models.PositiveIntegerField(default=0)
    updated_count = models.PositiveIntegerField(default=0)
    results_revision = models.PositiveBigIntegerField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["event", "idempotency_key"],
                name="one_roster_bulk_update_receipt_per_key",
            ),
            models.CheckConstraint(
                condition=models.Q(results_revision__gte=1),
                name="roster_bulk_receipt_revision_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.event.code} roster bulk / {self.idempotency_key}"
