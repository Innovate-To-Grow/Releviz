from django import forms
from django.contrib import admin
from django.http import HttpResponseRedirect
from django.urls import reverse
from unfold.widgets import UnfoldAdminPasswordWidget

from apps.core.models import SiteMaintenanceControl

from ..common.base import BaseModelAdmin


class MaterialOutlinedPasswordWidget(UnfoldAdminPasswordWidget):
    template_name = "admin/material_password_widget.html"

    class Media:
        js = ("admin/js/material-web-text-field.js",)


class SiteMaintenanceControlAdminForm(forms.ModelForm):
    bypass_password = forms.CharField(
        required=False,
        widget=MaterialOutlinedPasswordWidget(render_value=False),
        help_text="Enter a new bypass password to replace the current one.",
    )
    clear_bypass_password = forms.BooleanField(
        required=False,
        label="Clear bypass password",
        help_text="Remove the existing bypass password.",
    )

    class Meta:
        model = SiteMaintenanceControl
        fields = ("is_maintenance", "message", "bypass_password")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["bypass_password"].initial = ""

    def clean(self):
        cleaned_data = super().clean()
        if cleaned_data.get("clear_bypass_password"):
            cleaned_data["bypass_password"] = ""  # nosec B105
        elif not cleaned_data.get("bypass_password") and self.instance.pk:
            cleaned_data["bypass_password"] = self.instance.bypass_password
        return cleaned_data


@admin.register(SiteMaintenanceControl)
class SiteMaintenanceControlAdmin(BaseModelAdmin):
    form = SiteMaintenanceControlAdminForm
    list_display = ("__str__", "is_maintenance", "updated_at")
    fields = ("is_maintenance", "message", "bypass_password", "clear_bypass_password", "updated_at")
    readonly_fields = ("updated_at",)

    def changelist_view(self, request, extra_context=None):
        opts = self.model._meta
        config = SiteMaintenanceControl.objects.first()

        if config:
            url = reverse(
                f"admin:{opts.app_label}_{opts.model_name}_change",
                args=(config.pk,),
                current_app=self.admin_site.name,
            )
        else:
            url = reverse(
                f"admin:{opts.app_label}_{opts.model_name}_add",
                current_app=self.admin_site.name,
            )

        return HttpResponseRedirect(url)

    def has_add_permission(self, request):
        # Only allow one instance (singleton)
        if SiteMaintenanceControl.objects.exists():
            return False
        return super().has_add_permission(request)

    # noinspection PyUnusedLocal,PyMethodMayBeStatic
    def has_delete_permission(self, request, obj=None):
        return False
