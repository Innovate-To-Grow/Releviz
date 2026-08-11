import logging
import uuid
from datetime import date, datetime

from django.db import models
from django.http import QueryDict
from django.utils.timezone import is_aware

logger = logging.getLogger(__name__)


def serialize_post_data(post):
    """Serialize a QueryDict to a JSON-safe dict preserving multi-value keys."""
    return {key: post.getlist(key) for key in post}


def deserialize_post_data(data):
    """Reconstruct a mutable QueryDict from serialized data."""
    qd = QueryDict(mutable=True)
    for key, values in data.items():
        qd.setlist(key, values)
    return qd


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
                    "new_value": format_field_value(value),
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

        diff.append(
            {
                "field": field_name,
                # str() resolves lazy gettext labels — the diff is JSON-serialized
                # into the session, and a __proxy__ would raise at session save.
                "label": str(label),
                "old_value": format_field_value(old_value),
                "new_value": format_field_value(new_value),
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
            diff.append(
                {
                    "field": field.name,
                    "label": str(label),
                    "value": format_field_value(value),
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
