from django.db import models, transaction


class EmailServiceConfig(models.Model):
    """
    Email delivery configuration.

    AWS SES credentials and region live on ``AWSCredentialConfig``; this model
    stores email-specific settings like sender address and campaign
    throughput. Multiple configs can exist but only one may be active at a
    time.
    """

    name = models.CharField(
        max_length=128,
        default="Default",
        verbose_name="Config Name",
        help_text="A label to identify this configuration (e.g. 'Production SES', 'Dev SES').",
    )
    is_active = models.BooleanField(
        default=False,
        verbose_name="Active",
        help_text="Only one config can be active. Activating this will deactivate others.",
    )

    ses_from_email = models.CharField(
        max_length=254,
        blank=True,
        default="i2g@g.ucmerced.edu",
        verbose_name="From Email",
        help_text="Sender email address used by AWS SES.",
    )
    ses_from_name = models.CharField(
        max_length=128,
        blank=True,
        default="Innovate to Grow",
        verbose_name="From Name",
    )

    ses_max_send_rate = models.PositiveIntegerField(
        default=10,
        verbose_name="Campaign Send Rate (emails/sec)",
        help_text="Max emails per second for bulk campaigns. Keep below SES account limit to leave room for transactional mail.",
    )

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Email Service Config"
        verbose_name_plural = "Email Service Configs"
        constraints = [
            models.UniqueConstraint(
                fields=["is_active"],
                condition=models.Q(is_active=True),
                name="core_one_active_email_config",
            ),
        ]

    def __str__(self):
        status = " (active)" if self.is_active else ""
        provider = "AWS SES" if self.ses_configured else "AWS SES not configured"
        return f"{self.name}: {provider}{status}"

    def save(self, *args, **kwargs):
        if self.is_active:
            with transaction.atomic():
                list(EmailServiceConfig.objects.select_for_update().filter(is_active=True).exclude(pk=self.pk))
                EmailServiceConfig.objects.filter(is_active=True).exclude(pk=self.pk).update(is_active=False)
                super().save(*args, **kwargs)
        else:
            super().save(*args, **kwargs)

    @classmethod
    def load(cls):
        """Load the active config.

        Returns an unsaved instance with defaults when no active row exists so that
        callers can safely access properties like ``ses_configured`` without
        guarding against ``None``. Inactive sender settings are never used as a
        fallback.
        """
        try:
            return cls.objects.get(is_active=True)
        except cls.DoesNotExist:
            return cls()

    @property
    def source_address(self):
        """Formatted sender address for email headers."""
        if self.ses_from_name:
            return f"{self.ses_from_name} <{self.ses_from_email}>"
        return self.ses_from_email

    @property
    def ses_configured(self):
        """SES requires both an active sender row and active AWS credentials."""
        from apps.core.models import AWSCredentialConfig

        return bool(self.pk and self.is_active and self.ses_from_email and AWSCredentialConfig.load().ses_configured)
