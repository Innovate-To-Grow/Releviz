"""Status transitions and write windows for an event."""

from __future__ import annotations

from django.utils import timezone

from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import Event

LEGAL_TRANSITIONS = {
    Event.Status.ACTIVE: {Event.Status.CLOSED, Event.Status.ARCHIVED},
    Event.Status.FINALIZED: {Event.Status.ACTIVE},
    Event.Status.CLOSED: {Event.Status.ACTIVE, Event.Status.ARCHIVED},
    Event.Status.ARCHIVED: {Event.Status.ACTIVE},
}


class LifecycleError(ValueError):
    pass


def response_write_error(event, *, now=None) -> str | None:
    current_time = now or timezone.now()
    if event.status != Event.Status.ACTIVE:
        return f"Responses cannot change while the event is {event.status}."
    if event.response_deadline and current_time >= event.response_deadline:
        return "The response deadline has passed."
    return None


def event_configuration_write_error(event) -> str | None:
    if event.status in {Event.Status.FINALIZED, Event.Status.ARCHIVED}:
        return f"Scheduling settings cannot change while the event is {event.status}."
    return None


def transition_event(event, target_status: str, *, response_deadline, now=None) -> set[str]:
    current_time = now or timezone.now()
    valid_statuses = {choice for choice, _label in Event.Status.choices}
    if target_status not in valid_statuses:
        raise LifecycleError("Invalid event status.")
    if target_status == Event.Status.FINALIZED:
        raise LifecycleError("Confirm a final meeting time to finalize the event.")

    deadline_changed = response_deadline != event.response_deadline
    if target_status == event.status and not deadline_changed:
        return set()
    if target_status != event.status and target_status not in LEGAL_TRANSITIONS[event.status]:
        raise LifecycleError(f"Cannot transition an event from {event.status} to {target_status}.")
    if (
        target_status == Event.Status.ACTIVE
        and response_deadline is not None
        and current_time >= response_deadline
    ):
        raise LifecycleError("An active event must have a future response deadline.")

    changed_fields = {"version", "updated_at"}
    if deadline_changed:
        event.response_deadline = response_deadline
        changed_fields.add("response_deadline")
    previous_status = event.status
    if target_status != event.status:
        event.status = target_status
        changed_fields.add("status")
        if target_status == Event.Status.ACTIVE:
            event.opened_at = current_time
            event.finalized_at = None
            event.closed_at = None
            event.archived_at = None
            changed_fields.update({"opened_at", "finalized_at", "closed_at", "archived_at"})
        elif target_status == Event.Status.CLOSED:
            event.closed_at = current_time
            changed_fields.add("closed_at")
        else:
            event.archived_at = current_time
            changed_fields.add("archived_at")
        if previous_status == Event.Status.ACTIVE and target_status in {
            Event.Status.CLOSED,
            Event.Status.ARCHIVED,
        }:
            EmailDeliveryJob.objects.filter(
                event=event,
                message_type__in=(
                    EmailMessageLog.MessageType.INVITATION,
                    EmailMessageLog.MessageType.REMINDER,
                ),
                status__in=(
                    EmailDeliveryJob.Status.PENDING,
                    EmailDeliveryJob.Status.RETRY,
                ),
            ).update(
                status=EmailDeliveryJob.Status.CANCELED,
                last_error="The event is no longer accepting responses.",
                locked_at=None,
                lock_token=None,
                updated_at=current_time,
            )
    event.version += 1
    return changed_fields
