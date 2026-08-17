"""Idempotency receipt written when a roster import is committed."""

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import TimestampedModel

from ..events.event import Event
from .import_batch import RosterImportBatch


class RosterImportReceipt(TimestampedModel):
    class Mode(models.TextChoices):
        MERGE = "merge", "Merge"
        REBUILD = "rebuild", "Rebuild"

    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="roster_import_receipts",
    )
    batch = models.OneToOneField(
        RosterImportBatch,
        on_delete=models.PROTECT,
        related_name="receipt",
    )
    committed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="roster_import_receipts",
    )
    idempotency_key = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    mode = models.CharField(max_length=16, choices=Mode.choices)
    imported_count = models.PositiveIntegerField(default=0)
    created_count = models.PositiveIntegerField(default=0)
    updated_count = models.PositiveIntegerField(default=0)
    results_revision = models.PositiveBigIntegerField()
    committed_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-committed_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "idempotency_key"],
                name="one_roster_import_receipt_per_key",
            ),
            models.CheckConstraint(
                condition=models.Q(results_revision__gte=1),
                name="roster_receipt_results_revision_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.event.code} / {self.idempotency_key}"
