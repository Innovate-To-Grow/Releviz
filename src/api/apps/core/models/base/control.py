import uuid

from django.db import models

from ..managers import ProjectControlManager


class ProjectControlModel(models.Model):
    """
    Abstract base model combining UUID and timestamps.

    Features:
    - UUID as primary key
    - Automatic created_at and updated_at timestamps
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True, db_index=True)

    objects = ProjectControlManager()

    class Meta:
        abstract = True
