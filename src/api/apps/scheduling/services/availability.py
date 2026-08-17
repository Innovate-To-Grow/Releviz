"""Shape and validation of participant availability arrays."""

from apps.scheduling.services.slots import event_slot_count


def expected_availability_length(event) -> int:
    return event_slot_count(event)


def default_availability(event) -> list[int]:
    return [0] * expected_availability_length(event)


def validate_availability(availability, event, label: str):
    if not isinstance(availability, list):
        return f"Invalid {label}: must be an array"
    expected = expected_availability_length(event)
    if len(availability) != expected:
        return f"Invalid {label}: expected {expected} slots, got {len(availability)}"
    if not all(
        not isinstance(value, bool) and isinstance(value, int | float) and 0 <= value <= 1
        for value in availability
    ):
        return f"Invalid {label}: values must be numbers between 0 and 1"
    return None
