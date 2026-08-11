from django.db import models, transaction


class GmailAccessAccount(models.Model):
    """
    Gmail IMAP access account for importing HTML templates from sent mail.

    Multiple configs can exist but only one may be active at a time.
    Managed via Django admin under Site Settings.
    """

    name = models.CharField(
        max_length=128,
        default="Default",
        verbose_name="Config Name",
        help_text="A label to identify this account (e.g. 'Production Gmail Access').",
    )
    is_active = models.BooleanField(
        default=False,
        verbose_name="Active",
        help_text="Only one config can be active. Activating this will deactivate others.",
    )
    imap_host = models.CharField(
        max_length=254,
        blank=True,
        default="imap.gmail.com",
        verbose_name="IMAP Host",
    )
    gmail_username = models.CharField(
        max_length=254,
        blank=True,
        default="",
        verbose_name="Gmail Username",
        help_text="The Gmail account used to log in over IMAP and read sent messages.",
    )
    gmail_password = models.CharField(
        max_length=256,
        blank=True,
        default="",
        verbose_name="Gmail Password",
        help_text="Gmail app password used for IMAP login.",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Gmail Access Account"
        verbose_name_plural = "Gmail Access Accounts"
        constraints = [
            models.UniqueConstraint(
                fields=["is_active"],
                condition=models.Q(is_active=True),
                name="core_one_active_gmail_account",
            ),
        ]

    def __str__(self):
        status = " (active)" if self.is_active else ""
        mailbox = self.gmail_username or "unconfigured"
        return f"{self.name}: {mailbox}{status}"

    def save(self, *args, **kwargs):
        if self.is_active:
            with transaction.atomic():
                list(GmailAccessAccount.objects.select_for_update().filter(is_active=True).exclude(pk=self.pk))
                GmailAccessAccount.objects.filter(is_active=True).exclude(pk=self.pk).update(is_active=False)
                super().save(*args, **kwargs)
        else:
            super().save(*args, **kwargs)

    @classmethod
    def load(cls):
        """Load the active account without falling back to inactive credentials."""
        try:
            return cls.objects.get(is_active=True)
        except cls.DoesNotExist:
            return cls()

    @property
    def is_configured(self):
        return bool(self.imap_host and self.gmail_username and self.gmail_password)

    @property
    def mailbox(self):
        return self.gmail_username
