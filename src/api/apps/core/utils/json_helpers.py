"""JSON helpers for safely embedding values in HTML script contexts."""

import json

_JSON_SCRIPT_ESCAPES = {
    ord("<"): "\\u003C",
    ord(">"): "\\u003E",
    ord("&"): "\\u0026",
    0x2028: "\\u2028",
    0x2029: "\\u2029",
}


def safe_json(value, **kwargs):
    """Serialize to JSON, escaping characters that break HTML script contexts."""
    return json.dumps(value, **kwargs).translate(_JSON_SCRIPT_ESCAPES)
