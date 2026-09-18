"""Shared core models."""

from .base import (
    AWSCredentialConfig,
    ProjectControlModel,
    SiteMaintenanceControl,
    TimeStampedModel,
)
from .managers import ProjectControlManager, ProjectControlQuerySet
from .mixins import ActiveModel, AuthoredModel, OrderedModel
from .records import BackgroundJob, DeliveryRateLimit

# Backward-compatible alias: the class was renamed from TimestampedModel → TimeStampedModel
TimestampedModel = TimeStampedModel

__all__ = [
    "AWSCredentialConfig",
    "ActiveModel",
    "AuthoredModel",
    "BackgroundJob",
    "DeliveryRateLimit",
    "OrderedModel",
    "ProjectControlManager",
    "ProjectControlModel",
    "ProjectControlQuerySet",
    "SiteMaintenanceControl",
    "TimeStampedModel",
    "TimestampedModel",  # backward-compatible alias
]
