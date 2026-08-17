"""Event configuration, lifecycle, and write operations."""

from .codes import generate_event_code
from .configuration import (
    CONFIGURATION_FIELDS,
    GEOMETRY_FIELDS,
    RESULT_FIELDS,
    parse_event_configuration,
)
from .errors import EventManagementError
from .lifecycle import (
    LEGAL_TRANSITIONS,
    LifecycleError,
    event_configuration_write_error,
    response_write_error,
    transition_event,
)
from .mutations import create_event, delete_event, duplicate_event, update_event
from .types import EventDeleteResult, EventDuplicateResult, EventUpdateResult

__all__ = [
    "CONFIGURATION_FIELDS",
    "GEOMETRY_FIELDS",
    "LEGAL_TRANSITIONS",
    "RESULT_FIELDS",
    "EventDeleteResult",
    "EventDuplicateResult",
    "EventManagementError",
    "EventUpdateResult",
    "LifecycleError",
    "create_event",
    "delete_event",
    "duplicate_event",
    "event_configuration_write_error",
    "generate_event_code",
    "parse_event_configuration",
    "response_write_error",
    "transition_event",
    "update_event",
]
