"""Normalize preview rows and flag duplicates and validation errors."""

import math
from collections import defaultdict

from django.core.exceptions import ValidationError
from django.core.validators import validate_email

from apps.authn.models import ContactEmail
from apps.scheduling.models import RosterImportBatch, RosterImportRow
from apps.scheduling.services.invitations.addresses import phone_issue
from apps.scheduling.services.invitations.errors import (
    INACTIVE_ACCOUNT_MESSAGE,
    SHARED_ACCOUNT_MESSAGE,
    UNVERIFIED_FULL_ACCOUNT_MESSAGE,
)

from .errors import RosterImportError
from .limits import MAX_ROSTER_ROWS
from .mapping import display_cell, parse_included

_PHONE_ERRORS = {
    "too_long": "phone is too long (max 32).",
    "invalid": "phone is invalid.",
}


def _mapped_value(row: RosterImportRow, mapping: dict, field: str):
    if field not in mapping:
        return None, None
    index = mapping[field]
    value = row.raw_values[index] if index < len(row.raw_values) else ""
    if isinstance(value, dict) and "formula" in value:
        return None, f"{field} cannot contain a formula."
    if isinstance(value, str) and value.lstrip().startswith("="):
        return None, f"{field} cannot contain a formula."
    return value, None


def validate_identity_fields(name: str, email: str, group_name: str) -> list[str]:
    errors = []
    if not name:
        errors.append("name is required.")
    elif len(name) > 100:
        errors.append("name is too long (max 100).")
    if not email:
        errors.append("email is required.")
    elif len(email) > 254:
        errors.append("email is too long (max 254).")
    else:
        try:
            validate_email(email)
        except ValidationError:
            errors.append("email is invalid.")
    if len(group_name) > 100:
        errors.append("group is too long (max 100).")
    return errors


def validate_phone(phone: str) -> list[str]:
    issue = phone_issue(phone)
    return [_PHONE_ERRORS[issue]] if issue else []


def _normalize_row(row: RosterImportRow, mapping: dict, defaults: dict) -> None:
    errors = []
    raw_name, error = _mapped_value(row, mapping, "name")
    if error:
        errors.append(error)
    raw_email, error = _mapped_value(row, mapping, "email")
    if error:
        errors.append(error)
    if "name" not in mapping:
        errors.append("Map a name column.")
    if "email" not in mapping:
        errors.append("Map an email column.")

    raw_phone, error = _mapped_value(row, mapping, "phone")
    if error:
        errors.append(error)
    raw_group, error = _mapped_value(row, mapping, "group")
    if error:
        errors.append(error)
    raw_weight, error = _mapped_value(row, mapping, "weight")
    if error:
        errors.append(error)
    raw_included, error = _mapped_value(row, mapping, "included")
    if error:
        errors.append(error)

    name = display_cell(raw_name)
    email = display_cell(raw_email).lower()
    phone = display_cell(raw_phone) if "phone" in mapping else ""
    group_name = display_cell(raw_group) if "group" in mapping else str(defaults.get("group", ""))
    weight = defaults.get("weight", 1.0)
    if "weight" in mapping and raw_weight not in {None, ""}:
        try:
            weight = float(raw_weight)
            if not math.isfinite(weight) or weight < 0 or weight > 1:
                raise ValueError
        except (TypeError, ValueError):
            errors.append("weight must be between 0 and 1.")
            weight = 1.0
    included = defaults.get("included", True)
    if "included" in mapping and raw_included not in {None, ""}:
        try:
            included = parse_included(raw_included)
        except RosterImportError as exc:
            errors.append(str(exc))
            included = True

    errors.extend(validate_identity_fields(name, email, group_name))
    errors.extend(validate_phone(phone))
    row.name = name[:100]
    row.email = email[:254]
    row.phone = phone[:32]
    row.group_name = group_name[:100]
    row.weight = weight
    row.included = included
    row.selected = True
    row.validation_errors = list(dict.fromkeys(errors))
    row.duplicate_status = RosterImportRow.DuplicateStatus.UNIQUE


def _remove_duplicate_error(errors: list) -> list:
    return [error for error in errors if error != "Conflicting duplicate email."]


def apply_duplicate_rules(rows: list[RosterImportRow]) -> None:
    by_email = defaultdict(list)
    for row in rows:
        row.validation_errors = _remove_duplicate_error(row.validation_errors or [])
        if row.selected:
            row.duplicate_status = RosterImportRow.DuplicateStatus.UNIQUE
            if row.email:
                by_email[row.email].append(row)
        elif row.duplicate_status == RosterImportRow.DuplicateStatus.CONFLICT:
            row.duplicate_status = RosterImportRow.DuplicateStatus.UNIQUE

    for duplicates in by_email.values():
        if len(duplicates) < 2:
            continue
        signatures = {
            (
                row.name,
                row.email,
                row.group_name,
                row.phone,
                float(row.weight),
                bool(row.included),
            )
            for row in duplicates
        }
        if len(signatures) == 1:
            for duplicate in duplicates[1:]:
                duplicate.selected = False
                duplicate.duplicate_status = RosterImportRow.DuplicateStatus.IDENTICAL
            continue
        for duplicate in duplicates:
            duplicate.duplicate_status = RosterImportRow.DuplicateStatus.CONFLICT
            duplicate.validation_errors = list(
                dict.fromkeys(
                    [*(duplicate.validation_errors or []), "Conflicting duplicate email."]
                )
            )


_ACCOUNT_MESSAGES = frozenset(
    {INACTIVE_ACCOUNT_MESSAGE, UNVERIFIED_FULL_ACCOUNT_MESSAGE, SHARED_ACCOUNT_MESSAGE}
)


def _remove_account_errors(errors: list) -> list:
    return [error for error in errors if error not in _ACCOUNT_MESSAGES]


def apply_account_rules(rows: list[RosterImportRow]) -> None:
    """Flag selected rows whose address the commit would refuse to bind."""

    candidates = []
    for row in rows:
        row.validation_errors = _remove_account_errors(row.validation_errors or [])
        if row.selected and row.email:
            candidates.append(row)
    contacts = {
        contact.email_address.lower(): contact
        for contact in ContactEmail.objects.select_related("member").filter(
            email_address__in={row.email.lower() for row in candidates}
        )
    }
    by_member = defaultdict(list)
    for row in candidates:
        contact = contacts.get(row.email.lower())
        if contact is None or contact.member_id is None:
            continue
        by_member[contact.member_id].append(row)
        member = contact.member
        if not member.is_active:
            message = INACTIVE_ACCOUNT_MESSAGE
        elif getattr(member, "access_level", "full") == "full" and not contact.verified:
            message = UNVERIFIED_FULL_ACCOUNT_MESSAGE
        else:
            continue
        row.validation_errors = list(dict.fromkeys([*row.validation_errors, message]))
    # Unknown and orphan addresses each mint their own member at commit time, so
    # only rows bound to an existing member can collide on one account. Every row
    # in a group is flagged so the survivors clear once the others are deselected.
    for shared in by_member.values():
        if len(shared) < 2:
            continue
        for row in shared:
            row.validation_errors = list(
                dict.fromkeys([*row.validation_errors, SHARED_ACCOUNT_MESSAGE])
            )


def rows_summary(rows: list[RosterImportRow]) -> dict:
    selected = [row for row in rows if row.selected]
    valid = [row for row in selected if not row.validation_errors]
    conflicts = [
        row for row in selected if row.duplicate_status == RosterImportRow.DuplicateStatus.CONFLICT
    ]
    return {
        "total": len(rows),
        "selected": len(selected),
        "valid": len(valid),
        "invalid": len(selected) - len(valid),
        "conflicts": len(conflicts),
    }


def active_rows(batch: RosterImportBatch) -> list[RosterImportRow]:
    if not batch.selected_worksheet:
        return []
    return list(
        batch.rows.filter(
            worksheet=batch.selected_worksheet,
            row_number__gt=batch.header_row,
        ).order_by("row_number")
    )


def normalize_import_batch(batch: RosterImportBatch) -> None:
    if not batch.selected_worksheet:
        batch.summary = {
            "total": 0,
            "selected": 0,
            "valid": 0,
            "invalid": 0,
            "conflicts": 0,
        }
        batch.save(update_fields=["summary", "updated_at"])
        return
    batch.rows.exclude(worksheet=batch.selected_worksheet).update(selected=False)
    rows = active_rows(batch)
    for row in rows:
        _normalize_row(row, batch.column_mapping or {}, batch.defaults or {})
    apply_duplicate_rules(rows)
    apply_account_rules(rows)
    if rows_summary(rows)["valid"] > MAX_ROSTER_ROWS:
        raise RosterImportError(
            f"An import may contain at most {MAX_ROSTER_ROWS} valid participants."
        )
    if rows:
        RosterImportRow.objects.bulk_update(
            rows,
            [
                "name",
                "email",
                "phone",
                "group_name",
                "weight",
                "included",
                "selected",
                "validation_errors",
                "duplicate_status",
                "updated_at",
            ],
        )
    batch.summary = rows_summary(rows)
    batch.save(update_fields=["summary", "updated_at"])
