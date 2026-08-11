from typing import Any

from django.apps import apps
from django.db import models

from .constants import (
    DENIED_FIELD_NAMES,
    DENIED_MODEL_LABELS,
    DENIED_MODEL_NAME_PARTS,
    DENIED_READ_APP_LABELS,
    DENIED_WRITE_APP_LABELS,
    SAFE_LOOKUPS,
    SENSITIVE_FIELD_RE,
)
from .exceptions import ActionRequestError


def resolve_model(app_label: str, model_name: str, *, write: bool) -> type[models.Model]:
    try:
        model = apps.get_model((app_label or "").strip(), (model_name or "").strip())
    except LookupError as exc:
        raise ActionRequestError(f"Unknown model '{app_label}.{model_name}'.") from exc
    if is_model_denied(model, write=write):
        access = "write" if write else "read"
        raise ActionRequestError(f"{access.title()} access is not allowed for {model._meta.label}.")
    return model


def is_model_denied(model: type[models.Model], *, write: bool) -> bool:
    label = model._meta.label_lower
    denied_apps = DENIED_WRITE_APP_LABELS if write else DENIED_READ_APP_LABELS
    if model._meta.app_label in denied_apps or label in DENIED_MODEL_LABELS:
        return True
    return any(part in model._meta.model_name for part in DENIED_MODEL_NAME_PARTS)


def safe_model_fields(model: type[models.Model], *, write: bool) -> list[models.Field]:
    return [field for field in model._meta.fields if not is_field_denied(field, write=write)]


def is_field_denied(field: models.Field, *, write: bool) -> bool:
    name = field_output_name(field)
    if name in DENIED_FIELD_NAMES or field.name in DENIED_FIELD_NAMES:
        return True
    if SENSITIVE_FIELD_RE.search(name) or SENSITIVE_FIELD_RE.search(field.name):
        return True
    if isinstance(field, models.BinaryField | models.FileField):
        return True
    if write and (field.primary_key or not field.editable):
        return True
    if write and (getattr(field, "auto_now", False) or getattr(field, "auto_now_add", False)):
        return True
    return False


def field_output_name(field: models.Field) -> str:
    if getattr(field, "many_to_one", False) and getattr(field, "attname", None):
        return field.attname
    return field.name


def field_schema(field: models.Field) -> dict[str, Any]:
    return {
        "name": field_output_name(field),
        "type": field.__class__.__name__,
        "required": not field.blank and not field.null and not field.has_default(),
        "choices": [choice[0] for choice in getattr(field, "choices", None) or []],
    }


def validate_selected_fields(fields: list[str] | None, safe_names: set[str]) -> list[str]:
    if not isinstance(fields, list):
        raise ActionRequestError("fields must be a list.")
    selected = []
    for field in fields:
        if not isinstance(field, str) or field not in safe_names:
            raise ActionRequestError(f"Field '{field}' is not allowed.")
        selected.append(field)
    return selected


def validate_query_key(key: str, safe_names: set[str]) -> None:
    if not isinstance(key, str):
        raise ActionRequestError("Query fields must be strings.")
    bare = key.lstrip("-")
    parts = bare.split("__")
    if len(parts) > 2 or parts[0] not in safe_names:
        raise ActionRequestError(f"Field '{key}' is not allowed.")
    if len(parts) == 2 and parts[1] not in SAFE_LOOKUPS:
        raise ActionRequestError(f"Lookup '{parts[1]}' is not allowed.")


def validate_write_payload(model: type[models.Model], values: dict[str, Any]) -> dict[str, Any]:
    writable = {field_output_name(field): field for field in safe_model_fields(model, write=True)}
    clean = {}
    for name, value in values.items():
        if name not in writable:
            raise ActionRequestError(f"Field '{name}' is not writable for {model._meta.label}.")
        coerce_field_value(writable[name], value)
        clean[name] = value
    return clean


def assign_model_fields(obj: models.Model, values: dict[str, Any]) -> None:
    writable = {field_output_name(field): field for field in safe_model_fields(obj.__class__, write=True)}
    for name, value in values.items():
        field = writable[name]
        setattr(obj, field_output_name(field), coerce_field_value(field, value))


def coerce_field_value(field: models.Field, value: Any) -> Any:
    if value is None or isinstance(field, models.JSONField):
        return value
    if getattr(field, "many_to_one", False) and getattr(field, "target_field", None):
        return field.target_field.to_python(value)
    return field.to_python(value)


__all__ = [
    "assign_model_fields",
    "coerce_field_value",
    "field_output_name",
    "field_schema",
    "is_field_denied",
    "is_model_denied",
    "resolve_model",
    "safe_model_fields",
    "validate_query_key",
    "validate_selected_fields",
    "validate_write_payload",
]
