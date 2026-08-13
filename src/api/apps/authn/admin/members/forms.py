"""
Admin forms for authn app.
"""

from django import forms
from django.apps import apps as django_apps
from django.contrib import admin
from django.contrib.auth.forms import SetPasswordMixin
from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _
from unfold.forms import UserChangeForm, UserCreationForm

from ...models import Member


def admin_app_choices():
    """(app_label, verbose_name) choices for every Django app with registered admin models.

    Computed lazily (call at form ``__init__`` time, not import time) so the admin
    registry is fully populated. This is the menu of apps a member's ``admin_apps``
    grant can draw from — see apps.core.utils.access.user_can_access_app.
    """
    labels = sorted({model._meta.app_label for model in admin.site._registry})
    choices = []
    for label in labels:
        try:
            verbose = django_apps.get_app_config(label).verbose_name
        except LookupError:
            verbose = label
        choices.append((label, f"{verbose} ({label})"))
    return choices


class Base64ImageWidget(forms.ClearableFileInput):
    """File upload widget that stores the image as a base64-encoded string in a TextField."""

    # i2g-admin-file-input: see admin/css/file-input.css (WebKit file button styling).
    _file_classes = "i2g-admin-file-input block w-full text-sm text-font-default-light dark:text-font-default-dark"

    def __init__(self, attrs=None):
        defaults = {"class": self._file_classes}
        if attrs:
            defaults.update(attrs)
        super().__init__(attrs=defaults)

    def value_from_datadict(self, data, files, name):
        upload = files.get(name)
        if upload:
            import base64

            content_type = getattr(upload, "content_type", "image/png") or "image/png"
            b64 = base64.b64encode(upload.read()).decode("utf-8")
            return f"data:{content_type};base64,{b64}"
        # Check if the clear checkbox was checked
        checkbox_name = self.clear_checkbox_name(name)
        if checkbox_name in data:
            return ""
        return None  # No change

    # noinspection PyUnusedLocal,PyMethodMayBeStatic
    def format_value(self, value):
        # Return None so the default ClearableFileInput doesn't try to treat
        # the base64 string as a FieldFile object.
        return None

    def render(self, name, value, attrs=None, renderer=None):
        from django.utils.html import format_html

        widget_html = super().render(name, None, attrs, renderer)
        # If there's existing base64 data, show a thumbnail preview above the upload control
        if value and isinstance(value, str) and len(value) > 50:
            src = value if value.startswith("data:") else f"data:image/png;base64,{value}"
            preview = format_html(
                '<div class="mb-3 flex items-center gap-4">'
                '<img src="{}" alt="Profile preview"'
                ' class="rounded-default border border-base-200 dark:border-base-700 object-cover"'
                ' style="width:80px;height:80px" />'
                '<span class="text-xs text-font-subtle-light dark:text-font-subtle-dark">Current image</span>'
                "</div>",
                src,
            )
            return format_html("{}{}", preview, widget_html)
        return widget_html


class MemberCreationForm(UserCreationForm):
    """User creation form for the Member model with Unfold-styled password widgets.

    Passwords are optional: leave both blank to create the member with an unusable password
    (set a password later or use other auth). If either field is set, both must match.
    """

    class Meta(UserCreationForm.Meta):
        model = Member
        fields = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # The stock AdminUserCreationForm includes usable_password, but MemberAdmin.add_fieldsets
        # does not — leaving defaults would still require a password. Drop the field and use
        # validate_passwords() below.
        if "usable_password" in self.fields:
            del self.fields["usable_password"]
        self.fields["password1"].help_text = _(
            "Optional. If left empty, the member cannot sign in with a password until you set one (or they use other login methods)."
        )
        self.fields["password2"].help_text = _(
            "Optional. Must match the password field if you enter a password."
        )

    def validate_passwords(
        self,
        password1_field_name="password1",
        password2_field_name="password2",
    ):
        p1 = self.cleaned_data.get(password1_field_name) or ""
        p2 = self.cleaned_data.get(password2_field_name) or ""
        if not p1 and not p2:
            self.cleaned_data["set_usable_password"] = False
            return
        if bool(p1) != bool(p2):
            self.add_error(
                password2_field_name,
                ValidationError(
                    _("Enter the same password in both fields, or leave both empty."),
                    code="password_incomplete",
                ),
            )
            return
        self.cleaned_data["set_usable_password"] = True
        self.cleaned_data[password1_field_name] = p1
        self.cleaned_data[password2_field_name] = p2
        SetPasswordMixin.validate_passwords(self, password1_field_name, password2_field_name)


class MemberChangeForm(UserChangeForm):
    """User change form for the Member model with Unfold-styled password widget."""

    # Per-app admin grant. ``admin_apps`` is a JSONField (list of app labels), so it
    # cannot use admin ``filter_horizontal``; render it as a checkbox multi-select whose
    # choices are the project's registered admin apps. Replaces the old per-model
    # ``user_permissions`` widget.
    admin_apps = forms.MultipleChoiceField(
        required=False,
        widget=forms.CheckboxSelectMultiple,
        label=_("Admin apps"),
        help_text=_("Apps this member may manage. Superusers (I2G Master) ignore this list."),
    )

    class Meta(UserChangeForm.Meta):
        model = Member
        fields = "__all__"
        widgets = {
            "profile_image": Base64ImageWidget(attrs={"accept": "image/png,image/jpeg"}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # ``admin_apps`` is absent for non-superusers (the admin marks it
        # read-only so they can't self-grant app access), so only populate the
        # choices when the field is actually editable on this form.
        if "admin_apps" in self.fields:
            self.fields["admin_apps"].choices = admin_app_choices()

    def clean_profile_image(self):
        value = self.cleaned_data.get("profile_image")
        clear_name = self.fields["profile_image"].widget.clear_checkbox_name(
            self.add_prefix("profile_image")
        )
        if clear_name in self.data:
            return ""
        if value in (None, "") and self.instance.pk:
            return self.instance.profile_image
        return value


class MemberImportForm(forms.Form):
    """Form for importing members from Excel file."""

    _input_classes = (
        "w-full border border-base-200 dark:border-base-700 bg-white dark:bg-base-900"
        " text-font-default-light dark:text-font-default-dark rounded-default px-3 py-2 text-sm"
    )
    _file_classes = "i2g-admin-file-input block w-full text-sm text-font-default-light dark:text-font-default-dark"

    excel_file = forms.FileField(
        label="Excel File",
        help_text="Upload a .xlsx or .xls format Excel file",
        widget=forms.FileInput(
            attrs={
                "accept": ".xlsx,.xls",
                "class": _file_classes,
            }
        ),
    )

    set_password = forms.CharField(
        label="Default Password",
        required=False,
        help_text="Set a default password for imported users (leave empty to generate random passwords)",
        widget=forms.PasswordInput(
            attrs={
                "class": _input_classes,
                "autocomplete": "new-password",
            }
        ),
    )

    update_existing = forms.BooleanField(
        label="Update Existing Members",
        required=False,
        initial=False,
        help_text="If a member with the same primary email already exists, update their info instead of skipping",
    )

    def clean_excel_file(self):
        """Validate the uploaded file."""
        file = self.cleaned_data.get("excel_file")
        if file:
            # Check file extension
            if not file.name.endswith((".xlsx", ".xls")):
                raise forms.ValidationError("Please upload a .xlsx or .xls format file")

            # Check file size (max 5MB)
            if file.size > 5 * 1024 * 1024:
                raise forms.ValidationError("File size cannot exceed 5MB")

        return file
