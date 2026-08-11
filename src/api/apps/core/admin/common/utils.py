"""
Admin utility functions.
"""

import json

from django.urls import reverse
from django.utils.html import format_html
from django.utils.text import Truncator


# noinspection PyProtectedMember
def admin_url(obj, label=None):
    """
    Generate admin change URL for an object.

    Args:
        obj: Model instance
        label: Optional label text (defaults to str(obj))

    Returns:
        HTML link to admin change page
    """
    if not obj:
        return "-"

    app_label = obj._meta.app_label
    model_name = obj._meta.model_name
    url = reverse(f"admin:{app_label}_{model_name}_change", args=[obj.pk])

    if label is None:
        label = str(obj)

    return format_html('<a href="{}">{}</a>', url, label)


def truncate_text(text, max_length=50):
    """
    Truncate text to specified length.

    Args:
        text: Text to truncate
        max_length: Maximum length (default 50)

    Returns:
        Truncated text with ellipsis if needed
    """
    if not text:
        return "-"

    return Truncator(text).chars(max_length, truncate="...")


def format_json(data, indent=2):
    """
    Format data as pretty JSON.

    Args:
        data: Data to format (dict, list, etc.)
        indent: Indentation level

    Returns:
        Formatted JSON string
    """
    if data is None:
        return "-"

    try:
        if isinstance(data, str):
            # Try to parse if it's a JSON string
            data = json.loads(data)

        formatted = json.dumps(data, indent=indent, ensure_ascii=False, sort_keys=True)
        return format_html('<pre style="margin: 0;">{}</pre>', formatted)
    except (json.JSONDecodeError, TypeError):
        return format_html('<pre style="margin: 0;">{}</pre>', str(data))


def get_field_value(obj, field_name):
    """
    Get field value from object, handling related fields.

    Args:
        obj: Model instance
        field_name: Field name (can use __ for relations)

    Returns:
        Field value or None
    """
    if not obj:
        return None

    parts = field_name.split("__")
    value = obj

    for part in parts:
        if value is None:
            return None
        value = getattr(value, part, None)

    return value


def format_file_size(num_bytes):
    """
    Format bytes as human-readable file size.

    Args:
        num_bytes: Number of bytes

    Returns:
        Formatted string (e.g., "1.5 MB")
    """
    if num_bytes is None:
        return "-"

    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(num_bytes) < 1024.0:
            return f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024.0

    return f"{num_bytes:.1f} PB"


def format_duration(seconds):
    """
    Format seconds as human-readable duration.

    Args:
        seconds: Number of seconds

    Returns:
        Formatted string (e.g., "2h 15m")
    """
    if seconds is None:
        return "-"

    seconds = int(seconds)

    if seconds < 60:
        return f"{seconds}s"

    minutes = seconds // 60
    seconds = seconds % 60

    if minutes < 60:
        return f"{minutes}m {seconds}s" if seconds else f"{minutes}m"

    hours = minutes // 60
    minutes = minutes % 60

    if hours < 24:
        parts = []
        if hours:
            parts.append(f"{hours}h")
        if minutes:
            parts.append(f"{minutes}m")
        return " ".join(parts)

    days = hours // 24
    hours = hours % 24

    parts = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")

    return " ".join(parts) if parts else "0m"
