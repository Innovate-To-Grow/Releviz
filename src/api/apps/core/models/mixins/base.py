from django.conf import settings
from django.db import models


class AuthoredModel(models.Model):
    """Abstract base tracking who created/updated records."""

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="%(app_label)s_%(class)s_created",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="%(app_label)s_%(class)s_updated",
    )

    class Meta:
        abstract = True


class OrderedModel(models.Model):
    """Abstract base for orderable items."""

    order = models.PositiveIntegerField(default=0, db_index=True)

    class Meta:
        abstract = True
        ordering = ["order"]


class ActiveModel(models.Model):
    """Abstract base with active/inactive status."""

    is_active = models.BooleanField(default=True, db_index=True)

    class Meta:
        abstract = True
