"""Privacy-safe structured logging primitives."""

import json
import logging
import traceback
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path

request_id_context: ContextVar[str] = ContextVar("request_id", default="")

SAFE_LOG_FIELDS = (
    "request_id",
    "method",
    "path",
    "status_code",
    "duration_ms",
    "operation",
    "event_id",
    "member_id",
    "organizer_id",
    "requested_by",
    "auth_session_id",
    "delivery_job_id",
    "invitation_id",
    "message_type",
    "attempt",
    "status",
    "retry_after",
    "auth_scope",
    "auth_dimension",
    "auth_key",
    "staff_required",
    "revocation_reason",
    "session_count",
    "recipient_count",
    "deleted_version",
    "exception_type",
    "feedback_id",
    "category",
)


def _json_value(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


class RequestContextFilter(logging.Filter):
    """Attach the current request identifier to application log records."""

    def filter(self, record):
        if not getattr(record, "request_id", ""):
            record.request_id = request_id_context.get()
        return True


class JsonFormatter(logging.Formatter):
    """Emit a bounded JSON object without arbitrary ``LogRecord`` extras."""

    def format(self, record):
        payload = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "event": "django_request" if record.name == "django.request" else record.getMessage(),
        }
        for field in SAFE_LOG_FIELDS:
            value = getattr(record, field, None)
            if value not in (None, ""):
                payload[field] = _json_value(value)
        if record.exc_info:
            exception_type = record.exc_info[0].__name__
            frames = [
                {
                    "file": Path(frame.filename).name,
                    "line": frame.lineno,
                    "function": frame.name,
                }
                for frame in traceback.extract_tb(record.exc_info[2])
            ]
            payload["exception_type"] = exception_type
            payload["stack"] = frames
        return json.dumps(payload, separators=(",", ":"), sort_keys=True)
