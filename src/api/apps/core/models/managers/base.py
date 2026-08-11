from django.db import models


class ProjectControlQuerySet(models.QuerySet):
    """QuerySet for ProjectControlModel."""


class ProjectControlManager(models.Manager):
    """Default manager for ProjectControlModel."""

    def get_queryset(self):
        return ProjectControlQuerySet(self.model, using=self._db)
