from django.db import models

from apps.core.models import ProjectControlModel


class MemberSheetSyncLog(ProjectControlModel):
    """History of member-to-sheet sync operations."""

    class SyncType(models.TextChoices):
        DEBOUNCED = "debounced", "Debounced"
        FULL = "full", "Full Sync"
        SCHEDULED = "scheduled", "Scheduled"

    class Status(models.TextChoices):
        SUCCESS = "success", "Success"
        FAILED = "failed", "Failed"

    sync_type = models.CharField(max_length=10, choices=SyncType.choices)
    status = models.CharField(max_length=10, choices=Status.choices)
    rows_written = models.PositiveIntegerField(default=0)
    error_message = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.get_sync_type_display()} — {self.get_status_display()} — {self.rows_written} rows"
