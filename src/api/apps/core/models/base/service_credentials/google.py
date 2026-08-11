from django.core.exceptions import ValidationError
from django.db import models, transaction


def validate_google_credentials_json(value):
    """Validate that the value is a dict with required Google service-account fields."""
    if not isinstance(value, dict):
        raise ValidationError("Credentials must be a JSON object.")
    required = {"type", "project_id", "private_key", "client_email", "token_uri"}
    missing = required - value.keys()
    if missing:
        raise ValidationError(f"Missing required fields: {', '.join(sorted(missing))}")


class GoogleCredentialConfig(models.Model):
    """
    Google service-account credential configuration.

    Stores the contents of a Google Cloud service-account JSON key file.
    Multiple configs can exist but only one may be active at a time.
    Managed via Django admin under Site Settings.
    """

    name = models.CharField(
        max_length=128,
        default="Default",
        verbose_name="Config Name",
        help_text="A label to identify this configuration (e.g. 'Production Sheets', 'Dev Service Account').",
    )
    is_active = models.BooleanField(
        default=False,
        verbose_name="Active",
        help_text="Only one config can be active. Activating this will deactivate others.",
    )

    credentials_json = models.JSONField(
        default=dict,
        blank=True,
        verbose_name="Service Account JSON",
        help_text="Paste the full contents of the Google service-account JSON key file.",
        validators=[validate_google_credentials_json],
    )

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Google Credential Config"
        verbose_name_plural = "Google Credential Configs"
        constraints = [
            models.UniqueConstraint(
                fields=["is_active"],
                condition=models.Q(is_active=True),
                name="core_one_active_google_config",
            ),
        ]

    def __str__(self):
        status = " (active)" if self.is_active else ""
        project = self.credentials_json.get("project_id", "unknown") if self.credentials_json else "empty"
        return f"{self.name}: {project}{status}"

    def save(self, *args, **kwargs):
        if self.is_active:
            with transaction.atomic():
                list(GoogleCredentialConfig.objects.select_for_update().filter(is_active=True).exclude(pk=self.pk))
                GoogleCredentialConfig.objects.filter(is_active=True).exclude(pk=self.pk).update(is_active=False)
                super().save(*args, **kwargs)
        else:
            super().save(*args, **kwargs)

    @classmethod
    def load(cls):
        """Load the active config.

        Returns an unsaved instance with defaults when no active row exists so that
        callers can safely access properties like ``is_configured`` without
        guarding against ``None``. Inactive credentials are never used as a
        fallback.
        """
        try:
            return cls.objects.get(is_active=True)
        except cls.DoesNotExist:
            return cls()

    @property
    def is_configured(self):
        return bool(
            self.credentials_json
            and self.credentials_json.get("private_key")
            and self.credentials_json.get("client_email")
        )

    @property
    def project_id(self):
        return self.credentials_json.get("project_id", "") if self.credentials_json else ""

    @property
    def client_email(self):
        return self.credentials_json.get("client_email", "") if self.credentials_json else ""

    def get_credentials_info(self):
        """Return the credentials dict suitable for ``google.oauth2.service_account.Credentials.from_service_account_info()``."""
        return self.credentials_json if self.credentials_json else {}
