"""Optional, privacy-bounded Sentry initialization."""

from django.core.exceptions import ImproperlyConfigured
from sentry_sdk import init as sentry_init
from sentry_sdk.integrations.django import DjangoIntegration


def scrub_error_event(event, hint):
    """Remove request/user/log metadata while retaining exception diagnostics."""
    del hint
    for field in ("request", "user", "breadcrumbs", "extra", "tags"):
        event.pop(field, None)
    return event


def initialize_error_tracking(
    *,
    dsn: str,
    environment: str,
    release: str,
    traces_sample_rate: str,
) -> bool:
    """Initialize Sentry only when a DSN has been explicitly configured."""
    if not dsn:
        return False
    try:
        sample_rate = float(traces_sample_rate)
    except (TypeError, ValueError) as exc:
        raise ImproperlyConfigured("SENTRY_TRACES_SAMPLE_RATE must be a number.") from exc
    if not 0 <= sample_rate <= 1:
        raise ImproperlyConfigured("SENTRY_TRACES_SAMPLE_RATE must be between 0 and 1.")
    sentry_init(
        dsn=dsn,
        environment=environment or None,
        release=release or None,
        integrations=[DjangoIntegration(transaction_style="url")],
        send_default_pii=False,
        max_request_body_size="never",
        max_breadcrumbs=0,
        traces_sample_rate=sample_rate,
        before_send=scrub_error_event,
    )
    return True
