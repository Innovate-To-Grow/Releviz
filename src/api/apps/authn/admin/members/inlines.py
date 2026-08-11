from django import forms
from django.core.exceptions import ValidationError
from django.db import transaction
from django.forms.models import BaseInlineFormSet, InlineForeignKeyField
from unfold.admin import TabularInline

from apps.core.utils.access import user_can_access_app

from ...models import ContactEmail, ContactPhone, Member

PRIMARY_EMAIL_INLINE_EDIT_ERROR = (
    "The current primary email's address and type cannot be edited directly. "
    "Make another verified email primary from the Contact Emails admin."
)
PRIMARY_EMAIL_INLINE_DELETE_ERROR = (
    "The current primary email cannot be deleted directly. Make another email primary first."
)
PRIMARY_EMAIL_INLINE_PROMOTION_ERROR = (
    "A primary email cannot be assigned directly. "
    "Use the 'Make selected email primary' action in the Contact Emails admin."
)


class NoneSafeUUIDField(forms.UUIDField):
    """UUIDField that treats the literal string "None" as empty."""

    def to_python(self, value):
        if value in (None, "None", ""):
            return None
        return super().to_python(value)


class NoneSafeModelChoiceField(forms.ModelChoiceField):
    """ModelChoiceField that treats the literal string "None" as empty."""

    def to_python(self, value):
        if value in (None, "None", ""):
            return None
        return super().to_python(value)


class NoneSafeInlineForeignKeyField(InlineForeignKeyField):
    """Inline parent FK field that treats the literal string "None" as empty."""

    def clean(self, value):
        if value == "None":
            value = None
        return super().clean(value)


class NoneSafeUUIDInlineFormSet(BaseInlineFormSet):
    """Normalize literal 'None' values before inline UUID fields are bound."""

    def __init__(self, data=None, *args, **kwargs):
        prefix = kwargs.get("prefix")
        if data is not None and prefix:
            data = self._normalize_none_uuid_values(data, prefix)
        super().__init__(data, *args, **kwargs)

    @staticmethod
    def _normalize_none_uuid_values(data, prefix):
        normalized_data = data.copy()
        for key, values in list(normalized_data.lists()):
            if not key.startswith(f"{prefix}-") or not key.endswith(("-id", "-member")):
                continue
            normalized_values = ["" if value == "None" else value for value in values]
            if normalized_values != values:
                normalized_data.setlist(key, normalized_values)
        return normalized_data

    def add_fields(self, form, index):
        super().add_fields(form, index)
        field = form.fields.get("id")
        if field and isinstance(field, forms.ModelChoiceField):
            field.__class__ = NoneSafeModelChoiceField
        parent_field = form.fields.get(self.fk.name)
        if parent_field and isinstance(parent_field, InlineForeignKeyField):
            parent_field.__class__ = NoneSafeInlineForeignKeyField


class StaffPermissionInlineMixin:
    """Grant inline permissions per-app, matching BaseModelAdmin.

    These inlines belong to the Member admin, so access is gated on the ``authn`` app
    grant (see apps.core.utils.access.user_can_access_app) rather than bare ``is_staff``.
    """

    def _has_app_access(self, request):
        return user_can_access_app(request.user, self.model._meta.app_label)

    def has_view_permission(self, request, obj=None):
        return self._has_app_access(request)

    def has_add_permission(self, request, obj=None):
        return self._has_app_access(request)

    def has_change_permission(self, request, obj=None):
        return self._has_app_access(request)

    def has_delete_permission(self, request, obj=None):
        return self._has_app_access(request)


class UUIDInlineMixin:
    """Mixin that prevents 'None' string from being sent to UUID-backed inline fields."""

    formset = NoneSafeUUIDInlineFormSet

    def formfield_for_dbfield(self, db_field, request, **kwargs):
        formfield = super().formfield_for_dbfield(db_field, request, **kwargs)
        if formfield and isinstance(formfield, forms.UUIDField):
            formfield.__class__ = NoneSafeUUIDField
        return formfield


class ContactEmailInline(StaffPermissionInlineMixin, UUIDInlineMixin, TabularInline):
    """Inline admin for contact email records."""

    model = ContactEmail
    extra = 0
    verbose_name = "Contact Email"
    verbose_name_plural = "Contact Emails"
    fields = ("email_address", "email_type", "verified", "subscribe", "created_at")
    readonly_fields = ("created_at",)

    def get_formset(self, request, obj=None, **kwargs):
        formset_class = super().get_formset(request, obj, **kwargs)
        original_clean = formset_class.clean

        def clean(self_fs):
            original_clean(self_fs)
            # Member is the shared mutex used by the contact-email services.
            # The admin change view already owns an outer transaction, so this
            # lock remains held through save_formset() and prevents a concurrent
            # primary swap from invalidating the checks below.
            if (
                self_fs.instance.pk
                and not self_fs.instance._state.adding
                and transaction.get_connection().in_atomic_block
            ):
                Member.objects.select_for_update().get(pk=self_fs.instance.pk)

            persisted_emails = ContactEmail.objects.in_bulk(
                form.instance.pk for form in self_fs.forms if form.instance.pk
            )

            for form in self_fs.forms:
                if not hasattr(form, "cleaned_data"):
                    continue
                persisted = persisted_emails.get(form.instance.pk)
                if persisted is None:
                    continue

                delete_requested = form.cleaned_data.get("DELETE", False)
                requested_type = form.cleaned_data.get("email_type")
                if requested_type is None and form.is_bound:
                    requested_type = form.data.get(form.add_prefix("email_type"))
                requested_type = requested_type or persisted.email_type
                protected_changes = {"email_address", "email_type"}.intersection(form.changed_data)

                if persisted.email_type == "primary":
                    if delete_requested:
                        raise ValidationError(PRIMARY_EMAIL_INLINE_DELETE_ERROR)
                    if protected_changes:
                        raise ValidationError(PRIMARY_EMAIL_INLINE_EDIT_ERROR)
                elif requested_type == "primary":
                    raise ValidationError(PRIMARY_EMAIL_INLINE_PROMOTION_ERROR)

            primary_count = sum(
                1
                for form in self_fs.forms
                if not form.cleaned_data.get("DELETE", False) and form.cleaned_data.get("email_type") == "primary"
            )
            if primary_count > 1:
                raise ValidationError("A member may only have one primary email.")

        formset_class.clean = clean
        return formset_class


class ContactPhoneInline(StaffPermissionInlineMixin, UUIDInlineMixin, TabularInline):
    """Inline admin for contact phone records."""

    model = ContactPhone
    extra = 0
    verbose_name = "Contact Phone"
    verbose_name_plural = "Contact Phones"
    fields = ("phone_number", "region", "verified", "subscribe", "created_at")
    readonly_fields = ("created_at",)
