"""
Core admin utilities and base classes.

Provides shared functionality for admin interfaces across all apps.
"""

from .common import (
    BaseModelAdmin,
    ReadOnlyModelAdmin,
    admin_url,
    format_duration,
    format_file_size,
    format_json,
    get_field_value,
    truncate_text,
)
from .mixins import (
    ConfirmOnSaveMixin,
    DataExportMixin,
    ExcelExportMixin,
    TimestampedAdminMixin,
)
from .registrations import (  # noqa: F401 - register admin
    BackgroundJobAdmin,
    LogEntryAdmin,
    SiteMaintenanceControlAdmin,
)
from .service_credentials import (  # noqa: F401 - register admin
    GmailAccessAccountAdmin,
    GoogleCredentialConfigAdmin,
)

__all__ = [
    # Base classes
    "BaseModelAdmin",
    "ReadOnlyModelAdmin",
    # Mixins
    "ConfirmOnSaveMixin",
    "TimestampedAdminMixin",
    "DataExportMixin",
    "ExcelExportMixin",
    # Utilities
    "admin_url",
    "truncate_text",
    "format_json",
    "get_field_value",
    "format_file_size",
    "format_duration",
]
