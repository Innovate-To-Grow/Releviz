"""Shared, security-critical safe-ORM primitives.

Promoted out of ``apps.system_intelligence.services.actions`` so the model
introspection / denylist / write-validation / cascade-impact layer is a single
source of truth reused by both the AI chat action engine and the ``cli_admin``
admin-API surface. The ``system_intelligence`` modules keep thin re-export shims
at their old import paths for backwards compatibility.
"""

from .cascade import cascade_summary, collect_cascade_impact
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
from .json import json_safe
from .records import (
    assert_snapshot_unchanged,
    check_model_permission,
    clone_model_instance,
    get_object,
    record_repr,
    serialize_model_instance,
)
from .safety import (
    assign_model_fields,
    coerce_field_value,
    field_output_name,
    field_schema,
    is_field_denied,
    is_model_denied,
    resolve_model,
    safe_model_fields,
    validate_query_key,
    validate_selected_fields,
    validate_write_payload,
)

__all__ = [
    "DENIED_FIELD_NAMES",
    "DENIED_MODEL_LABELS",
    "DENIED_MODEL_NAME_PARTS",
    "DENIED_READ_APP_LABELS",
    "DENIED_WRITE_APP_LABELS",
    "SAFE_LOOKUPS",
    "SENSITIVE_FIELD_RE",
    "ActionRequestError",
    "assert_snapshot_unchanged",
    "assign_model_fields",
    "cascade_summary",
    "check_model_permission",
    "clone_model_instance",
    "coerce_field_value",
    "collect_cascade_impact",
    "field_output_name",
    "field_schema",
    "get_object",
    "is_field_denied",
    "is_model_denied",
    "json_safe",
    "record_repr",
    "resolve_model",
    "safe_model_fields",
    "serialize_model_instance",
    "validate_query_key",
    "validate_selected_fields",
    "validate_write_payload",
]
