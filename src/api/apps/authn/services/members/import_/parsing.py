"""Parsing helpers for member import spreadsheets."""

from __future__ import annotations

import secrets
import string
from datetime import datetime

from django.utils import timezone

HEADER_MAP = {
    "first name": "first_name",
    "first_name": "first_name",
    "firstname": "first_name",
    "last name": "last_name",
    "last_name": "last_name",
    "lastname": "last_name",
    "middle name": "middle_name",
    "middle_name": "middle_name",
    "title": "title",
    "title - role": "title",
    "title - role (optional)": "title",
    "when started": "when_started",
    "when_started": "when_started",
    "date joined": "when_started",
    "date_joined": "when_started",
    "last updated": "last_updated",
    "last_updated": "last_updated",
    "active": "is_active",
    "staff": "is_staff",
    "primary expired": "primary_expired",
    "primary_expired": "primary_expired",
    "primary email": "primary_email",
    "primary_email": "primary_email",
    "email": "primary_email",
    "primary verified": "primary_verified",
    "primary_verified": "primary_verified",
    "primary subscribed": "primary_subscribed",
    "primary_subscribed": "primary_subscribed",
    "secondary email": "secondary_email",
    "secondary_email": "secondary_email",
    "secondary verified": "secondary_verified",
    "secondary_verified": "secondary_verified",
    "secondary subscribed": "secondary_subscribed",
    "secondary_subscribed": "secondary_subscribed",
    "secondary expired": "secondary_expired",
    "secondary_expired": "secondary_expired",
    "secondary bounced": "secondary_bounced",
    "secondary_bounced": "secondary_bounced",
    "phone number": "phone_number",
    "phone_number": "phone_number",
    "phone": "phone_number",
    "phone number subscribed": "phone_subscribed",
    "phone_number_subscribed": "phone_subscribed",
    "phone subscribed": "phone_subscribed",
    "phone_subscribed": "phone_subscribed",
    "phone number verified": "phone_verified",
    "phone_number_verified": "phone_verified",
    "phone verified": "phone_verified",
    "phone_verified": "phone_verified",
    "organization": "organization",
    "organization (optional)": "organization",
    "company": "organization",
    "org": "organization",
}
DATE_FORMATS = [
    "%Y-%m-%d %I:%M %p",
    "%Y-%m-%d %I:%M:%S %p",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%m/%d/%Y %I:%M:%S %p",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y",
    "%m/%d/%y",
]


def generate_random_password(length: int = 12) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def normalize_header(header: str) -> str:
    if not header:
        return ""
    return HEADER_MAP.get(str(header).strip().lower(), str(header).strip().lower())


def parse_boolean(value) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in ("true", "yes", "1", "y", "active")


def parse_date(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return timezone.make_aware(value) if timezone.is_naive(value) else value
    str_val = str(value).strip()
    if not str_val:
        return None
    for fmt in DATE_FORMATS:
        try:
            return timezone.make_aware(datetime.strptime(str_val, fmt))
        except ValueError:
            continue
    return None


def clean_phone(value) -> str | None:
    if value is None:
        return None
    stripped = str(value).strip()
    if not stripped:
        return None
    # Remove trailing ".0" from Excel numeric conversion
    if stripped.endswith(".0"):
        stripped = stripped[:-2]
    # Strip non-digit characters except leading +
    digits_only = "".join(c for c in stripped if c.isdigit())
    if not digits_only:
        return None
    # Normalize to E.164 format (preserve leading +)
    if stripped.startswith("+"):
        return f"+{digits_only}"
    return f"+{digits_only}"


def parse_row(row_num: int, row_data: dict) -> dict:
    primary_email = str(row_data.get("primary_email", "")).strip() if row_data.get("primary_email") else None
    secondary_email = str(row_data.get("secondary_email", "")).strip() if row_data.get("secondary_email") else None
    return {
        "row": row_num,
        "primary_email": primary_email,
        "first_name": str(row_data.get("first_name", "")).strip() if row_data.get("first_name") else "",
        "last_name": str(row_data.get("last_name", "")).strip() if row_data.get("last_name") else "",
        "middle_name": str(row_data.get("middle_name", "")).strip() if row_data.get("middle_name") else "",
        "title": str(row_data.get("title", "")).strip() if row_data.get("title") else "",
        "organization": str(row_data.get("organization", "")).strip() if row_data.get("organization") else "",
        "is_active": parse_boolean(row_data.get("is_active")) if row_data.get("is_active") is not None else None,
        "is_staff": parse_boolean(row_data.get("is_staff")) if row_data.get("is_staff") is not None else None,
        "date_joined": parse_date(row_data.get("when_started")),
        "primary_verified": parse_boolean(row_data.get("primary_verified")),
        "primary_subscribed": parse_boolean(row_data.get("primary_subscribed")),
        "secondary_email": secondary_email,
        "secondary_verified": parse_boolean(row_data.get("secondary_verified")),
        "secondary_subscribed": parse_boolean(row_data.get("secondary_subscribed")),
        "phone_number": clean_phone(row_data.get("phone_number")),
        "phone_subscribed": parse_boolean(row_data.get("phone_subscribed")),
        "phone_verified": parse_boolean(row_data.get("phone_verified")),
    }
