from django.contrib.auth.hashers import check_password, identify_hasher, make_password
from django.db import models
from django.utils.crypto import constant_time_compare


def _looks_like_password_hash(value: str) -> bool:
    if not value:
        return False
    try:
        identify_hasher(value)
        return True
    except ValueError:
        return False


class SiteMaintenanceControl(models.Model):
    """
    Singleton model to control site-wide maintenance mode.

    When `is_maintenance` is True, the health check endpoint returns
    maintenance status and the frontend displays a maintenance page
    with the configured message.
    """

    is_maintenance = models.BooleanField(
        default=False,
        verbose_name="Maintenance Mode",
        help_text="Enable to put the site into maintenance mode.",
    )
    message = models.TextField(
        blank=True,
        default="We are performing scheduled maintenance. Please try again shortly.",
        verbose_name="Maintenance Message",
        help_text="Message displayed to users during maintenance.",
    )
    bypass_password = models.CharField(
        max_length=128,
        blank=True,
        default="",
        verbose_name="Bypass Password",
        help_text="Password that allows authorized users to bypass maintenance mode. Leave blank to disable bypass.",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Site Maintenance Control"
        verbose_name_plural = "Site Maintenance Control"

    def __str__(self):
        status = "ON" if self.is_maintenance else "OFF"
        return f"Maintenance Mode: {status}"

    # noinspection PyAttributeOutsideInit
    def save(self, *args, **kwargs):
        # Enforce singleton: always use pk=1
        self.pk = 1
        if self.bypass_password and not _looks_like_password_hash(self.bypass_password):
            self.bypass_password = make_password(self.bypass_password)
        super().save(*args, **kwargs)

    def check_bypass_password(self, password: str) -> bool:
        if not self.bypass_password:
            return False
        if _looks_like_password_hash(self.bypass_password):
            return check_password(password, self.bypass_password)
        return constant_time_compare(password, self.bypass_password)

    @classmethod
    def load(cls):
        """Load the singleton instance, creating it with defaults if needed."""
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj
