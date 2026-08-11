import time
from datetime import timedelta
from math import isfinite

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.models import DeliveryRateLimit


def configured_ses_rate(config) -> float:
    """Return a finite non-negative SES rate from a service configuration."""
    try:
        rate = float(config.ses_max_send_rate or 0)
    except (AttributeError, TypeError, ValueError):
        return 0.0
    return rate if isfinite(rate) and rate > 0 else 0.0


def reserve_delivery_slot(
    provider: str,
    sends_per_second: float,
    *,
    now=None,
) -> float:
    """Atomically reserve one global provider-call slot and return its delay."""
    if sends_per_second <= 0:
        return 0.0
    initial_time = now or timezone.now()
    interval = timedelta(seconds=1 / sends_per_second)
    with transaction.atomic():
        try:
            limiter = DeliveryRateLimit.objects.select_for_update().get(provider=provider)
        except DeliveryRateLimit.DoesNotExist:
            try:
                with transaction.atomic():
                    DeliveryRateLimit.objects.create(
                        provider=provider,
                        next_available_at=initial_time,
                    )
            except IntegrityError:
                pass
            limiter = DeliveryRateLimit.objects.select_for_update().get(provider=provider)

        # A competing worker may have held the row lock for a meaningful amount
        # of time. Re-read the clock after acquiring it so expired reservations
        # do not turn into an unintended burst. ``now`` remains a deterministic
        # test hook for arithmetic checks.
        current_time = now or timezone.now()
        reserved_at = max(current_time, limiter.next_available_at)
        limiter.next_available_at = reserved_at + interval
        limiter.save(update_fields=["next_available_at", "updated_at"])
    return max(0.0, (reserved_at - current_time).total_seconds())


def wait_for_delivery_slot(provider: str, sends_per_second: float) -> float:
    """Reserve and wait for a shared slot; return the wait for observability/tests."""
    delay = reserve_delivery_slot(provider, sends_per_second)
    if delay > 0:
        time.sleep(delay)
    return delay
