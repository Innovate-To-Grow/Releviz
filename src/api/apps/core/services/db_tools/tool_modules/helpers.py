"""Database query tools for AI chat Bedrock tool-use integration."""

import json
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

MAX_ROWS = 50
MAX_RESULT_CHARS = 4000


def _truncate(text, limit=MAX_RESULT_CHARS):
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... (truncated, {len(text)} total chars)"


def _serialize_rows(qs, fields, limit=MAX_ROWS, *, fallback_fields=None):
    """Serialize a queryset to a JSON-ish string."""
    rows = list(qs.values(*fields)[:limit])
    for row in rows:
        for field, fallback_field in (fallback_fields or {}).items():
            if row.get(field) is None:
                row[field] = row.get(fallback_field)
        for k, v in row.items():
            if isinstance(v, datetime):
                row[k] = v.isoformat()
            elif hasattr(v, "hex"):
                row[k] = str(v)
    count = qs.count()
    header = f"Showing {min(count, limit)} of {count} result(s).\n"
    return _truncate(header + json.dumps(rows, indent=2, default=str))
