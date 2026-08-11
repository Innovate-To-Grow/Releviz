"""
Shared abstract base model for timestamp fields.

NOTE: Most domain models in this project inherit from
``apps.core.models.ProjectControlModel``, which provides a UUID primary key plus
``created_at``/``updated_at`` timestamps — and nothing else (there is no soft
delete and no version tracking; deletes are hard). ``TimeStampedModel`` here is
the lighter, framework-standard base offered for new models that only need
timestamps and do not want a UUID primary key. It is abstract, so it adds no
database table and no migration.
"""

from django.db import models


class TimeStampedModel(models.Model):
    """Abstract base adding self-managed ``created_at`` / ``updated_at`` fields."""

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True
        get_latest_by = "created_at"
