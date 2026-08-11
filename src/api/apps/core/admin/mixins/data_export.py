"""Column-selectable admin data export mixin."""

import json
import uuid
from datetime import date, datetime

from django.contrib import admin
from django.template.response import TemplateResponse

from .files import generate_excel_response, generate_json_response

EXPORT_CONFIRM_PARAM = "export_confirm"
EXPORT_FORMATS = [("xlsx", "Excel (.xlsx)"), ("json", "JSON (.json)")]


class DataExportMixin:
    """
    Adds a single "Export selected data" admin action with an intermediate
    page for choosing output format, filename, and columns.
    """

    export_fields = None
    export_filename = None
    actions_no_confirmation = ["export_data"]

    @property
    def excel_export_fields(self):
        return self.export_fields

    @excel_export_fields.setter
    def excel_export_fields(self, value):
        self.export_fields = value

    @property
    def excel_export_filename(self):
        return self.export_filename

    @excel_export_filename.setter
    def excel_export_filename(self, value):
        self.export_filename = value

    def get_export_fields(self):
        """Return [(field_name, verbose_name), ...] for exportable columns."""
        if self.export_fields:
            fields = []
            for name in self.export_fields:
                try:
                    field = self.model._meta.get_field(name)
                    fields.append((name, field.verbose_name.title()))
                except Exception:
                    fields.append((name, name.replace("_", " ").title()))
            return fields
        return [(f.name, f.verbose_name.title()) for f in self.model._meta.fields]

    def get_export_value(self, obj, field_name):
        """Serialise a single field value for export."""
        value = getattr(obj, field_name, None)
        if value is None:
            return ""
        if isinstance(value, datetime):
            return value.strftime("%Y-%m-%d %H:%M:%S")
        if isinstance(value, date):
            return value.strftime("%Y-%m-%d")
        if isinstance(value, bool):
            return "Yes" if value else "No"
        if isinstance(value, uuid.UUID):
            return str(value)
        if isinstance(value, list | dict):
            return json.dumps(value, ensure_ascii=False, default=str)
        if hasattr(value, "pk"):
            return str(value)
        return value

    def get_excel_export_fields(self):
        return self.get_export_fields()

    def get_excel_export_value(self, obj, field_name):
        return self.get_export_value(obj, field_name)

    @admin.action(description="Export selected data")
    def export_data(self, request, queryset):
        if EXPORT_CONFIRM_PARAM not in request.POST:
            return self._render_column_selection(request, queryset)
        fmt = request.POST.get("export_format", "xlsx")
        if fmt == "json":
            return self._generate_json(request, queryset)
        return self._generate_excel(request, queryset)

    def get_actions(self, request):
        actions = super().get_actions(request)
        actions["export_data"] = (
            type(self).export_data,
            "export_data",
            "Export selected data",
        )
        return actions

    def _get_base_filename(self, request):
        return request.POST.get("export_filename", "").strip() or self.export_filename or self.model._meta.model_name

    def _resolve_columns(self, request):
        """Return [(field_name, label), ...] from user selection, or all columns."""
        selected = request.POST.getlist("export_fields")
        all_fields = dict(self.get_export_fields())
        columns = [(name, all_fields[name]) for name in selected if name in all_fields]
        return columns or list(self.get_export_fields())

    def _render_column_selection(self, request, queryset):
        """Show the intermediate column and format picker page."""
        available_fields = self.get_export_fields()
        pks = queryset.values_list("pk", flat=True)

        preview_limit = 5
        preview_rows = []
        for obj in queryset[:preview_limit]:
            preview_rows.append([(name, self.get_export_value(obj, name)) for name, _label in available_fields])

        context = {
            **self.admin_site.each_context(request),
            "title": f"Export {self.model._meta.verbose_name_plural.title()}",
            "queryset": queryset,
            "pks": [str(pk) for pk in pks],
            "available_fields": available_fields,
            "preview_rows": preview_rows,
            "formats": EXPORT_FORMATS,
            "default_filename": self.export_filename or self.model._meta.model_name,
            "opts": self.model._meta,
            "action_checkbox_name": admin.helpers.ACTION_CHECKBOX_NAME,
            "confirm_param": EXPORT_CONFIRM_PARAM,
            "media": self.media,
        }
        return TemplateResponse(request, "admin/core/export_columns.html", context)

    def _generate_excel(self, request, queryset):
        return generate_excel_response(self, request, queryset, self._resolve_columns(request))

    def _generate_json(self, request, queryset):
        return generate_json_response(self, request, queryset, self._resolve_columns(request))
