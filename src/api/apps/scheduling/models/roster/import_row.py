"""A single normalized row inside a roster import batch."""

from django.db import models

from apps.core.models import TimestampedModel

from .import_batch import RosterImportBatch


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
