"""Result objects returned by event write operations."""

from dataclasses import dataclass

from apps.scheduling.models import Event


@dataclass(frozen=True)
class EventUpdateResult:
    event: Event
    responses_reset: int
    idempotent: bool


@dataclass(frozen=True)
class EventDuplicateResult:
    event: Event
    idempotent: bool


@dataclass(frozen=True)
class EventDeleteResult:
    code: str
    idempotent: bool
