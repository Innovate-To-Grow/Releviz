"""Timestamp admin mixin."""


class TimestampedAdminMixin:
    def get_readonly_fields(self, request, obj=None):
        readonly = list(super().get_readonly_fields(request, obj))
        for field in ("created_at", "updated_at"):
            if hasattr(self.model, field) and field not in readonly:
                readonly.append(field)
        return readonly

    def get_list_display(self, request):
        list_display = list(super().get_list_display(request))
        if hasattr(self.model, "created_at") and "created_at" not in list_display:
            list_display.append("created_at")
        return list_display
