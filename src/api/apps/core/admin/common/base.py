"""
Base admin classes for consistent admin interface across the project.
"""

from unfold.admin import ModelAdmin

from ..mixins import (
    AppAccessPermissionMixin,
    ConfirmOnSaveMixin,
    DataExportMixin,
    TimestampedAdminMixin,
)


class BaseModelAdmin(
    AppAccessPermissionMixin,
    ConfirmOnSaveMixin,
    DataExportMixin,
    TimestampedAdminMixin,
    ModelAdmin,
):
    """
    Base admin class with common configuration for all model admins.

    Provides:
    - Unfold theme integration
    - Common readonly fields for ProjectControlModel
    - Timestamp readonly fields
    - Standard list display configuration
    - Shared administrator access control: every active administrator may
      manage models across every app (see apps.core.utils.access.user_can_access_app).
    """

    # Common readonly fields for ProjectControlModel
    readonly_fields_base = ("id", "created_at", "updated_at")

    # Standard list configuration
    list_per_page = 50

    def get_readonly_fields(self, request, obj=None):
        """Include base readonly fields with any model-specific ones."""
        readonly = list(super().get_readonly_fields(request, obj))

        # Add base fields if model has them
        if hasattr(self.model, "created_at"):
            for field in self.readonly_fields_base:
                if hasattr(self.model, field) and field not in readonly:
                    readonly.append(field)

        return readonly


class ReadOnlyModelAdmin(BaseModelAdmin):
    """
    Admin class for read-only models.

    Useful for audit logs, system records, or any model that should
    not be edited through the admin interface.
    """

    require_confirmation = False

    def has_add_permission(self, request):
        """Prevent adding new objects."""
        return False

    def has_change_permission(self, request, obj=None):
        """Prevent changing objects."""
        return False

    def has_delete_permission(self, request, obj=None):
        """Prevent deleting objects."""
        return False

    def get_actions(self, request, action_location=None):
        """Remove all actions."""
        if action_location is None:
            actions = super().get_actions(request)
        else:
            actions = super().get_actions(request, action_location=action_location)
        if actions and "delete_selected" in actions:
            del actions["delete_selected"]
        return actions
