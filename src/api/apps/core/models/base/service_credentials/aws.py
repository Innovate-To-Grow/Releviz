from django.db import models, transaction

from apps.core.services.aws.crypto import decrypt_secret, encrypt_secret


class AWSCredentialConfig(models.Model):
    """
    Unified AWS configuration.

    Stores the IAM access key and AWS region used by SES (email) and
    Bedrock (System Intelligence). Both services share the same region.
    Multiple configs can exist but only one may be active at a time.
    Managed via Django admin under Site Settings.
    """

    name = models.CharField(
        max_length=128,
        default="Default",
        verbose_name="Config Name",
        help_text="A label to identify this configuration (e.g. 'Production IAM', 'Dev Account').",
    )
    is_active = models.BooleanField(
        default=False,
        verbose_name="Active",
        help_text="Only one config can be active. Activating this will deactivate others.",
    )

    access_key_id = models.CharField(
        max_length=128,
        blank=True,
        default="",
        verbose_name="Access Key ID",
        help_text="AWS IAM access key ID (starts with AKIA…). Shared by SES and Bedrock.",
    )
    encrypted_secret_access_key = models.TextField(
        blank=True,
        default="",
        verbose_name="Encrypted Secret Access Key",
        help_text="AWS IAM secret access key, encrypted at rest with Fernet.",
    )
    default_region = models.CharField(
        max_length=32,
        blank=True,
        default="us-west-2",
        verbose_name="AWS Region",
        help_text="AWS region used by SES and Bedrock.",
    )

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "AWS Credential"
        verbose_name_plural = "AWS Credentials"
        constraints = [
            models.UniqueConstraint(
                fields=["is_active"],
                condition=models.Q(is_active=True),
                name="core_one_active_aws_config",
            ),
        ]

    def __str__(self):
        status = " (active)" if self.is_active else ""
        key_hint = f"...{self.access_key_id[-4:]}" if self.access_key_id else "empty"
        return f"{self.name}: {key_hint}{status}"

    def save(self, *args, **kwargs):
        # Serialize concurrent activations so only one config is ever active:
        # lock the active rows, deactivate them, then activate self atomically.
        # select_for_update is a no-op on SQLite (dev), effective on PostgreSQL.
        if self.is_active:
            with transaction.atomic():
                list(
                    AWSCredentialConfig.objects.select_for_update()
                    .filter(is_active=True)
                    .exclude(pk=self.pk)
                )
                AWSCredentialConfig.objects.filter(is_active=True).exclude(pk=self.pk).update(
                    is_active=False
                )
                super().save(*args, **kwargs)
        else:
            super().save(*args, **kwargs)

    def set_secret_access_key(self, value: str) -> None:
        """Encrypt and store the AWS secret access key."""
        if value:
            self.encrypted_secret_access_key = encrypt_secret(value)
        else:
            self.encrypted_secret_access_key = ""

    def get_secret_access_key(self) -> str:
        """Decrypt and return the AWS secret access key."""
        return decrypt_secret(self.encrypted_secret_access_key)

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
    def region(self) -> str:
        return self.default_region or "us-west-2"

    @property
    def is_configured(self) -> bool:
        return bool(self.access_key_id and self.get_secret_access_key())

    @property
    def ses_configured(self) -> bool:
        return self.is_configured
