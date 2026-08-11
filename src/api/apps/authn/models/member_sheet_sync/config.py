from django.db import models, transaction

from apps.core.models import ProjectControlModel


class MemberSheetSyncConfig(ProjectControlModel):
    """
    Singleton-ish configuration for syncing members to a Google Sheet.

    Multiple rows may exist but only the enabled one is used.
    Follows the same load() pattern as GoogleCredentialConfig.
    """

    is_enabled = models.BooleanField(
        default=False,
        verbose_name="Enabled",
        help_text="Enable member-to-sheet sync (manual sync and management command).",
    )
    auto_sync_enabled = models.BooleanField(
        default=False,
        verbose_name="Auto Sync",
        help_text=(
            "Automatically sync to the sheet when a member, contact email, or contact phone "
            "is created, updated, or deleted. Changes are coalesced through the durable "
            "background-job queue."
        ),
    )
    google_sheet_id = models.CharField(
        max_length=255,
        blank=True,
        default="",
        verbose_name="Google Sheet ID",
        help_text="The spreadsheet ID from the Google Sheets URL.",
    )
    worksheet_gid = models.IntegerField(
        null=True,
        blank=True,
        verbose_name="Worksheet GID",
        help_text="Target worksheet GID. Leave blank to use the first sheet.",
    )

    synced_at = models.DateTimeField(null=True, blank=True, verbose_name="Last Synced At")
    sync_count = models.PositiveIntegerField(default=0, verbose_name="Last Sync Row Count")
    sync_error = models.TextField(blank=True, default="", verbose_name="Last Sync Error")

    class Meta:
        verbose_name = "Member Sheet Sync Config"
        verbose_name_plural = "Member Sheet Sync Configs"
        constraints = [
            models.UniqueConstraint(
                fields=["is_enabled"],
                condition=models.Q(is_enabled=True),
                name="authn_one_enabled_member_sync",
            ),
        ]

    def __str__(self):
        status = "enabled" if self.is_enabled else "disabled"
        sheet = self.google_sheet_id[:20] if self.google_sheet_id else "no sheet"
        return f"MemberSync ({status}, {sheet})"

    def save(self, *args, **kwargs):
        # Enforce a single enabled config — saving an enabled row demotes any others.
        # Mirrors the pattern in core.models.GoogleCredentialConfig.save().
        if self.is_enabled:
            with transaction.atomic():
                list(type(self).objects.select_for_update().filter(is_enabled=True).exclude(pk=self.pk))
                type(self).objects.filter(is_enabled=True).exclude(pk=self.pk).update(is_enabled=False)
                super().save(*args, **kwargs)
        else:
            super().save(*args, **kwargs)

    @classmethod
    def load(cls):
        """Load the explicitly enabled config.

        Returns an unsaved instance with defaults when no enabled row exists so that
        callers can safely access properties like ``is_configured`` without
        guarding against ``None``. Disabled sync settings are never used as a
        fallback.
        """
        try:
            return cls.objects.get(is_enabled=True)
        except cls.DoesNotExist:
            return cls()

    @property
    def is_configured(self):
        return self.is_enabled and bool(self.google_sheet_id)
