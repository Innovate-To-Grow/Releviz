"""
Custom DRF exception handler.

Opt-in building block. It is NOT wired into ``REST_FRAMEWORK["EXCEPTION_HANDLER"]``
because doing so would change error-response shapes across every endpoint. To
enable it globally, set ``EXCEPTION_HANDLER`` to
``"apps.core.utils.exceptions.exception_handler"`` in settings.

It delegates to DRF's default handler and, when that produces a response,
normalizes the body to a consistent envelope while preserving the original
status code and field-level detail.
"""

from rest_framework.views import exception_handler as drf_exception_handler


def exception_handler(exc, context):
    """Wrap DRF's default handler with a consistent ``{"error": {...}}`` envelope."""
    response = drf_exception_handler(exc, context)
    if response is None:
        return None

    detail = response.data
    response.data = {
        "error": {
            "status_code": response.status_code,
            "detail": detail,
        }
    }
    return response
