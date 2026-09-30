"""Shared administrator permissions for model admins."""

from apps.core.utils.access import user_can_access_app


class AppAccessPermissionMixin:
    """Give every active administrator access to admin pages and actions."""

    def _has_app_access(self, request) -> bool:
        return user_can_access_app(request.user, self.opts.app_label)

    def has_module_permission(self, request):
        return self._has_app_access(request)

    def has_view_permission(self, request, obj=None):
        return self._has_app_access(request)

    def has_add_permission(self, request):
        return self._has_app_access(request)

    def has_change_permission(self, request, obj=None):
        return self._has_app_access(request)

    def has_delete_permission(self, request, obj=None):
        return self._has_app_access(request)
