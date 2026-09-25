"""Normalize preview rows and flag duplicates and validation errors."""

import math
from collections import defaultdict

from django.core.exceptions import ValidationError
from django.core.validators import validate_email

from apps.authn.models import ContactEmail
from apps.scheduling.models import RosterImportBatch, RosterImportRow
from apps.scheduling.services.invitations.addresses import (
    NO_ORGANIZER_ADDRESSES,
    OrganizerAddresses,
    organizer_addresses,
    phone_issue,
)
from apps.scheduling.services.invitations.errors import (
    INACTIVE_ACCOUNT_MESSAGE,
    SHARED_ACCOUNT_MESSAGE,
    UNVERIFIED_FULL_ACCOUNT_MESSAGE,
)
from apps.scheduling.services.roster_groups import (
    MAX_GROUPS_PER_CELL,
    format_group_cell,
    parse_group_cell,
)

from .errors import RosterImportError
from .limits import MAX_ROSTER_ROWS
from .mapping import display_cell, parse_included

_PHONE_ERRORS = {
    "too_long": "phone is too long (max 32).",
    "invalid": "phone is invalid.",
}
DUPLICATE_EMAIL_MESSAGE = "Conflicting duplicate email."
DUPLICATE_NAME_MESSAGE = "Conflicting duplicate name."
UNVERIFIED_OWN_ADDRESS_MESSAGE = (
    "Verify this address on your account before using it for someone without an email."
)


def batch_organizer_addresses(batch: RosterImportBatch) -> OrganizerAddresses:
    return organizer_addresses(batch.event.organizer_id)


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


def normalize_group_cell(value) -> str:
    """Return a group cell in its canonical ``ALL; A; B`` spelling.

    A cell that does not parse is kept as typed (stripped) so the organizer
    sees it next to the error ``validate_identity_fields`` reports for it.
    """

    cell = str(value if value is not None else "").strip()
    try:
        return format_group_cell(*parse_group_cell(cell))
    except RosterImportError:
        return cell


def validate_identity_fields(
    name: str,
    email: str,
    group_name: str,
    *,
    addresses: OrganizerAddresses = NO_ORGANIZER_ADDRESSES,
) -> list[str]:
    errors = []
    if not name:
        errors.append("name is required.")
    elif len(name) > 100:
        errors.append("name is too long (max 100).")
    if not email:
        # A blank email is someone the organizer manages, filed under their
        # primary address; without a verified one there is nowhere to file them.
        if not addresses.default:
            errors.append("email is required.")
    elif len(email) > 254:
        errors.append("email is too long (max 254).")
    elif email in addresses.owned:
        if email not in addresses.verified:
            errors.append(UNVERIFIED_OWN_ADDRESS_MESSAGE)
    else:
        try:
            validate_email(email)
        except ValidationError:
            errors.append("email is invalid.")
    try:
        parse_group_cell(group_name)
    except RosterImportError as exc:
        errors.append(str(exc))
    return errors


def validate_phone(phone: str) -> list[str]:
    issue = phone_issue(phone)
    return [_PHONE_ERRORS[issue]] if issue else []


def _normalize_row(
    row: RosterImportRow,
    mapping: dict,
    defaults: dict,
    addresses: OrganizerAddresses = NO_ORGANIZER_ADDRESSES,
) -> None:
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
    group_cell = display_cell(raw_group) if "group" in mapping else defaults.get("group") or ""
    group_name = normalize_group_cell(group_cell)
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

    errors.extend(validate_identity_fields(name, email, group_name, addresses=addresses))
    errors.extend(validate_phone(phone))
    row.name = name[:100]
    row.email = email[:254]
    row.phone = phone[:32]
    row.group_name = group_name
    row.weight = weight
    row.included = included
    row.selected = True
    row.validation_errors = list(dict.fromkeys(errors))
    row.duplicate_status = RosterImportRow.DuplicateStatus.UNIQUE


def _remove_duplicate_error(errors: list) -> list:
    return [
        error for error in errors if error not in {DUPLICATE_EMAIL_MESSAGE, DUPLICATE_NAME_MESSAGE}
    ]


def managed_key(address: str, name: str) -> tuple[str, str]:
    """Who a person without an email of their own is: their filing address and name."""

    return address.lower(), name.lower()


def _identity_key(row: RosterImportRow, addresses: OrganizerAddresses):
    """Rows sharing a key land on one roster entry: an account by email, or a
    person the organizer manages by filing address and name."""

    if addresses.manages(row.email):
        if not row.name:
            return None
        return ("managed", *managed_key(addresses.contact_for(row.email), row.name))
    return ("email", row.email) if row.email else None


def _merged_group_cell(rows: list[RosterImportRow]) -> str | None:
    """The union of the rows' group cells in canonical form.

    ``None`` when a cell does not parse or the union outgrows one cell: the
    rows then cannot collapse into one and are left for the organizer.
    """

    if len({row.group_name for row in rows}) == 1:
        # Byte-identical cells need no parsing: an invalid one keeps its own
        # row error and the copies still collapse into the first row.
        return rows[0].group_name
    all_groups = False
    names = []
    seen = set()
    for row in rows:
        try:
            cell_all_groups, cell_names = parse_group_cell(row.group_name)
        except RosterImportError:
            return None
        all_groups = all_groups or cell_all_groups
        for name in cell_names:
            key = name.lower()
            if key not in seen:
                seen.add(key)
                names.append(name)
    if len(names) > MAX_GROUPS_PER_CELL:
        return None
    return format_group_cell(all_groups, names)


def apply_duplicate_rules(
    rows: list[RosterImportRow],
    addresses: OrganizerAddresses = NO_ORGANIZER_ADDRESSES,
) -> None:
    """Collapse identical rows for one person and flag the ones that differ.

    Rows that agree on everything but the group cell are the same person
    listed under several groups: the first row survives with the union of
    every cell and the rest are deselected as identical.
    """

    by_identity = defaultdict(list)
    for row in rows:
        row.validation_errors = _remove_duplicate_error(row.validation_errors or [])
        if row.selected:
            row.duplicate_status = RosterImportRow.DuplicateStatus.UNIQUE
            key = _identity_key(row, addresses)
            if key is not None:
                by_identity[key].append(row)
        elif row.duplicate_status == RosterImportRow.DuplicateStatus.CONFLICT:
            row.duplicate_status = RosterImportRow.DuplicateStatus.UNIQUE

    for (kind, address, *_name), duplicates in by_identity.items():
        if len(duplicates) < 2:
            continue
        signatures = {
            (row.name, address, row.phone, float(row.weight), bool(row.included))
            for row in duplicates
        }
        merged = _merged_group_cell(duplicates) if len(signatures) == 1 else None
        if merged is not None:
            duplicates[0].group_name = merged
            for duplicate in duplicates[1:]:
                duplicate.selected = False
                duplicate.duplicate_status = RosterImportRow.DuplicateStatus.IDENTICAL
            continue
        message = DUPLICATE_NAME_MESSAGE if kind == "managed" else DUPLICATE_EMAIL_MESSAGE
        for duplicate in duplicates:
            duplicate.duplicate_status = RosterImportRow.DuplicateStatus.CONFLICT
            duplicate.validation_errors = list(
                dict.fromkeys([*(duplicate.validation_errors or []), message])
            )


_ACCOUNT_MESSAGES = frozenset(
    {INACTIVE_ACCOUNT_MESSAGE, UNVERIFIED_FULL_ACCOUNT_MESSAGE, SHARED_ACCOUNT_MESSAGE}
)


def _remove_account_errors(errors: list) -> list:
    return [error for error in errors if error not in _ACCOUNT_MESSAGES]


def apply_account_rules(
    rows: list[RosterImportRow],
    addresses: OrganizerAddresses = NO_ORGANIZER_ADDRESSES,
) -> None:
    """Flag selected rows whose address the commit would refuse to bind.

    Rows under the organizer's own addresses describe people the organizer
    manages, so they never bind to an account and are left alone.
    """

    candidates = []
    for row in rows:
        row.validation_errors = _remove_account_errors(row.validation_errors or [])
        if row.selected and row.email and row.email not in addresses.owned:
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
    addresses = batch_organizer_addresses(batch)
    for row in rows:
        _normalize_row(row, batch.column_mapping or {}, batch.defaults or {}, addresses)
    apply_duplicate_rules(rows, addresses)
    apply_account_rules(rows, addresses)
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
