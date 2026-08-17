"""Staged roster import previews plus the receipts for committed roster writes."""

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import TimestampedModel
from apps.scheduling.models.events import Event


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


class RosterImportRow(TimestampedModel):
    class DuplicateStatus(models.TextChoices):
        UNIQUE = "unique", "Unique"
        IDENTICAL = "identical", "Identical duplicate"
        CONFLICT = "conflict", "Conflicting duplicate"

    batch = models.ForeignKey(
        RosterImportBatch,
        on_delete=models.CASCADE,
        related_name="rows",
    )
    worksheet = models.CharField(max_length=128)
    row_number = models.PositiveIntegerField()
    raw_values = models.JSONField(default=list)
    name = models.CharField(max_length=100, blank=True, default="")
    email = models.EmailField(blank=True, default="")
    group_name = models.CharField(max_length=100, blank=True, default="")
    weight = models.FloatField(default=1.0)
    included = models.BooleanField(default=True)
    selected = models.BooleanField(default=False)
    validation_errors = models.JSONField(default=list)
    duplicate_status = models.CharField(
        max_length=16,
        choices=DuplicateStatus.choices,
        default=DuplicateStatus.UNIQUE,
    )

    class Meta:
        ordering = ["worksheet", "row_number"]
        constraints = [
            models.UniqueConstraint(
                fields=["batch", "worksheet", "row_number"],
                name="one_roster_import_row_position",
            ),
            models.CheckConstraint(
                condition=models.Q(weight__gte=0.0, weight__lte=1.0),
                name="roster_import_weight_in_range",
            ),
        ]
        indexes = [
            models.Index(fields=["batch", "worksheet", "row_number"]),
            models.Index(fields=["batch", "selected", "duplicate_status"]),
        ]

    def __str__(self) -> str:
        return f"{self.batch_id} / {self.worksheet}:{self.row_number}"


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
