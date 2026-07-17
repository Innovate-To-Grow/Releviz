from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.core.exceptions import ValidationError


def validate_iana_timezone(value: str) -> None:
    try:
        ZoneInfo(str(value))
    except (TypeError, ValueError, ZoneInfoNotFoundError) as exc:
        raise ValidationError("Enter a valid IANA timezone, such as America/Los_Angeles.") from exc
