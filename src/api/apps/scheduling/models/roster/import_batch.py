"""Staging batch for a roster import preview."""

from django.conf import settings
from django.db import models

from apps.core.models import TimestampedModel

from ..events.event import Event


class RosterImportBatch(TimestampedModel):
    class SourceType(models.TextChoices):
        CSV = "csv", "CSV upload"
        XLSX = "xlsx", "Excel upload"
        PASTE = "paste", "Pasted table"

    class Status(models.TextChoices):
        PREVIEW = "preview", "Preview"
        COMMITTING = "committing", "Committing"
        COMMITTED = "committed", "Committed"
        CANCELED = "canceled", "Canceled"
        EXPIRED = "expired", "Expired"
        FAILED = "failed", "Failed"

    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="roster_import_batches",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="roster_import_batches",
    )
    source_type = models.CharField(max_length=16, choices=SourceType.choices)
    source_label = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PREVIEW)
    worksheets = models.JSONField(default=list)
    selected_worksheet = models.CharField(max_length=128, blank=True, default="")
    header_row = models.PositiveIntegerField(default=1)
    column_mapping = models.JSONField(default=dict)
    defaults = models.JSONField(default=dict)
    summary = models.JSONField(default=dict)
    expires_at = models.DateTimeField()
    failure_reason = models.CharField(max_length=500, blank=True, default="")

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["event", "status", "created_at"]),
            models.Index(fields=["status", "expires_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.event.code} roster import [{self.status}]"
