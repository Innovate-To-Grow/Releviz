import logging
import uuid
from datetime import date, datetime

from django import forms
from django.db import models
from django.http import QueryDict
from django.utils.timezone import is_aware

from apps.core.services.aws.crypto import decrypt_secret, encrypt_secret

logger = logging.getLogger(__name__)

# The confirmation page shows this instead of a secret, such as a password-widget
# value (which the form itself never renders back) or a stored password hash.
SECRET_MASK = "••••••••"
# Columns whose stored value is a secret, for the delete confirmation.
SECRET_COLUMN_MARKERS = ("password", "secret", "private_key")


def serialize_post_data(post, secret_keys=()):
    """Serialize a QueryDict to a JSON-safe dict preserving multi-value keys.

    The values of ``secret_keys`` are encrypted, since the session is stored as is.
    """
    return {
        key: [encrypt_secret(value) for value in post.getlist(key)]
        if key in secret_keys
        else post.getlist(key)
        for key in post
    }


def deserialize_post_data(data, secret_keys=()):
    """Reconstruct a mutable QueryDict from serialized data."""
    qd = QueryDict(mutable=True)
    for key, values in data.items():
        qd.setlist(
            key, [decrypt_secret(value) for value in values] if key in secret_keys else values
        )
    return qd


def secret_post_keys(form):
    """Return the POST keys of ``form``'s password-widget fields."""
    return [form.add_prefix(name) for name in form.fields if _is_secret_field(form, name)]


def _display_value(value, secret):
    """Format a value for the diff, masking a non-empty secret."""
    if secret and value not in (None, ""):
        return SECRET_MASK
    return format_field_value(value)


def _is_secret_field(form, field_name):
    return isinstance(form.fields[field_name].widget, forms.PasswordInput)


def compute_add_diff(form):
    """Compute diff for a new object being added."""
    diff = []
    for field_name in form.fields:
        if field_name in form.cleaned_data:
            value = form.cleaned_data[field_name]
            label = form.fields[field_name].label or field_name
            diff.append(
                {
                    "field": field_name,
                    # str() resolves lazy gettext labels — the diff is JSON-serialized
                    # into the session, and a __proxy__ would raise at session save.
                    "label": str(label),
                    "new_value": _display_value(value, _is_secret_field(form, field_name)),
                }
            )
    return diff


def compute_change_diff(model_class, object_id, form):
    """Compute diff for changed fields on an existing object."""
    if not form.changed_data:
        return []

    try:
        old_obj = model_class.objects.get(pk=object_id)
    except model_class.DoesNotExist:
        return []

    diff = []
    for field_name in form.changed_data:
        if field_name not in form.fields:
            continue
        label = form.fields[field_name].label or field_name
        new_value = form.cleaned_data.get(field_name)

        try:
            field = model_class._meta.get_field(field_name)
            old_value = getattr(old_obj, field_name)
            if isinstance(field, models.ForeignKey):
                old_value = getattr(old_obj, field_name)
        except Exception:
            old_value = getattr(old_obj, field_name, None)

        secret = _is_secret_field(form, field_name)
        diff.append(
            {
                "field": field_name,
                # str() resolves lazy gettext labels — the diff is JSON-serialized
                # into the session, and a __proxy__ would raise at session save.
                "label": str(label),
                "old_value": _display_value(old_value, secret),
                "new_value": _display_value(new_value, secret),
            }
        )
    return diff


def compute_delete_diff(obj):
    """Compute diff for an object being deleted — shows all current field values."""
    diff = []
    for field in obj._meta.get_fields():
        if not hasattr(field, "column"):
            continue
        if field.name in ("id", "pk"):
            continue
        try:
            value = getattr(obj, field.name)
            label = getattr(field, "verbose_name", field.name)
            if isinstance(label, str):
                label = label.capitalize()
            secret = any(marker in field.name for marker in SECRET_COLUMN_MARKERS)
            diff.append(
                {
                    "field": field.name,
                    "label": str(label),
                    "value": _display_value(value, secret),
                }
            )
        except Exception as exc:
            logger.debug("Skipping field %s in delete diff: %s", field.name, exc)
    return diff


def format_field_value(value):
    """Format a field value for human-readable display."""
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, datetime):
        fmt = "%Y-%m-%d %H:%M:%S"
        if is_aware(value):
            fmt += " %Z"
        return value.strftime(fmt)
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, models.Model):
        return str(value)
    if isinstance(value, list | dict):
        import json

        try:
            return json.dumps(value, ensure_ascii=False, default=str)[:200]
        except (TypeError, ValueError):
            return str(value)[:200]
    if isinstance(value, models.QuerySet):
        return ", ".join(str(v) for v in value[:10])
    value_str = str(value)
    if len(value_str) > 200:
        return value_str[:200] + "..."
    return value_str
