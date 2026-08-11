"""
Admin log entry viewer.

Registers Django's built-in LogEntry model in the admin so staff can
review recent admin actions (adds, changes, deletes) from a single page.
"""

from django.contrib import admin
from django.contrib.admin.models import LogEntry

from ..common.base import ReadOnlyModelAdmin


class LogEntryAdmin(ReadOnlyModelAdmin):
    list_display = ("action_time", "user", "content_type", "object_repr", "action_flag_display")
    list_filter = ("action_flag", "content_type", "user")
    search_fields = ("object_repr", "change_message")
    date_hierarchy = "action_time"
    list_per_page = 50

    def action_flag_display(self, obj):
        return obj.get_action_flag_display()

    action_flag_display.short_description = "Action"

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


try:
    admin.site.unregister(LogEntry)
except admin.sites.NotRegistered:
    pass
admin.site.register(LogEntry, LogEntryAdmin)
