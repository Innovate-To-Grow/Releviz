import json
from datetime import datetime

from django.apps import apps as django_apps

from ..helpers import MAX_ROWS, _serialize_rows, _truncate
from .allowlist import ALLOWED_QUERY_FIELDS, MODEL_MAP, SAFE_LOOKUPS


def is_allowed_query_key(model_name, key):
    """Accept only field or field__lookup keys from the model allowlist."""
    bare = key.lstrip("-")
    parts = bare.split("__")
    if len(parts) > 2:
        return False
    allowed = ALLOWED_QUERY_FIELDS.get(model_name, set())
    if parts[0] not in allowed:
        return False
    return not (len(parts) == 2 and parts[1] not in SAFE_LOOKUPS)


def allowed_output_fields(model_name):
    return sorted(ALLOWED_QUERY_FIELDS.get(model_name, set()))


def validate_output_fields(model_name, fields):
    allowed = set(allowed_output_fields(model_name))
    invalid = [field for field in fields if not isinstance(field, str) or field not in allowed]
    if invalid:
        return f"Fields error: field '{invalid[0]}' is not allowed for {model_name}."
    return ""


def run_custom_query(params):
    """Flexible query tool with an allowlist of models and fields."""
    model_name = params.get("model", "")
    if model_name not in MODEL_MAP:
        return f"Unknown model '{model_name}'. Available: {', '.join(sorted(MODEL_MAP))}"
    app_label, model_class_name = MODEL_MAP[model_name]
    model_cls = django_apps.get_model(app_label, model_class_name, require_ready=True)
    qs = model_cls.objects.all()
    filtered = apply_filters(qs, model_name, params.get("filters", {}))
    if isinstance(filtered, str):
        return filtered
    ordered = apply_ordering(filtered, model_name, params.get("ordering"))
    if isinstance(ordered, str):
        return ordered
    if params.get("count_only"):
        return f"Count: {ordered.count()}"
    return serialize_custom_rows(ordered, model_name, params)


def apply_filters(qs, model_name, filters):
    if isinstance(filters, dict) and filters:
        for key in filters:
            if not is_allowed_query_key(model_name, key):
                return f"Filter error: field '{key}' is not allowed for {model_name}."
        try:
            return qs.filter(**filters)
        except Exception as exc:
            return f"Filter error: {exc}"
    return qs


def apply_ordering(qs, model_name, ordering):
    if not ordering:
        return qs
    ordering = [ordering] if isinstance(ordering, str) else ordering
    for key in ordering:
        if not is_allowed_query_key(model_name, key):
            return f"Ordering error: field '{key}' is not allowed for {model_name}."
    try:
        return qs.order_by(*ordering)
    except Exception as exc:
        return f"Ordering error: {exc}"


def serialize_custom_rows(qs, model_name, params):
    limit = min(params.get("limit", MAX_ROWS), MAX_ROWS)
    fields = params.get("fields")
    if fields and isinstance(fields, list):
        validation_error = validate_output_fields(model_name, fields)
        if validation_error:
            return validation_error
        return _serialize_rows(qs, fields, limit)
    rows = list(qs.values(*allowed_output_fields(model_name))[:limit])
    for row in rows:
        for key, value in row.items():
            if isinstance(value, datetime):
                row[key] = value.isoformat()
            elif hasattr(value, "hex"):
                row[key] = str(value)
    count = qs.count()
    return _truncate(
        f"Showing {min(count, limit)} of {count} result(s) from {model_name}.\n"
        + json.dumps(rows, indent=2, default=str)
    )
