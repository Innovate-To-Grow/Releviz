"""JSON payload builders for the scheduling API.

These functions own the wire shape of the API responses. They read models and
service results only; nothing in ``services`` depends on this package.
"""

from .delivery import delivery_request_status_payload, email_delivery_request_payload
from .events import api_event, api_final_meeting
from .invitations import api_invitation
from .participants import api_participant, api_weight
from .roster import (
    roster_import_payload,
    roster_import_receipt_payload,
    roster_import_row_payload,
)

__all__ = [
    "api_event",
    "api_final_meeting",
    "api_invitation",
    "api_participant",
    "api_weight",
    "delivery_request_status_payload",
    "email_delivery_request_payload",
    "roster_import_payload",
    "roster_import_receipt_payload",
    "roster_import_row_payload",
]
