"""Header detection, column mapping, and default values."""

import math
from collections import defaultdict

from .errors import RosterImportError
from .limits import MAX_COLUMNS

_HEADER_ALIASES = {
    "name": {"name", "full name", "participant", "participant name", "attendee"},
    "email": {"email", "email address", "e-mail", "e-mail address"},
    "group": {"group", "group name", "department", "cohort", "team"},
    "weight": {"weight", "priority"},
    "included": {"included", "include", "counted", "enabled"},
}
MAPPING_KEYS = set(_HEADER_ALIASES)


def display_cell(value) -> str:
    if isinstance(value, dict) and "formula" in value:
        return f"={value['formula']}"
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip()


def _canonical_header(value) -> str:
    return " ".join(display_cell(value).lower().replace("_", " ").split())


def auto_mapping(headers: list) -> dict:
    mapping = {}
    for index, header in enumerate(headers):
        canonical = _canonical_header(header)
        for field, aliases in _HEADER_ALIASES.items():
            if field not in mapping and canonical in aliases:
                mapping[field] = index
    return mapping


def worksheet_metadata(raw_rows: list[dict]) -> list[dict]:
    grouped = defaultdict(list)
    for row in raw_rows:
        grouped[row["worksheet"]].append(row)
    metadata = []
    for worksheet, rows in grouped.items():
        rows.sort(key=lambda item: item["row_number"])
        first = rows[0]
        metadata.append(
            {
                "name": worksheet,
                "rowCount": max(len(rows) - 1, 0),
                "columnCount": max(len(row["raw_values"]) for row in rows),
                "headers": [display_cell(value) for value in first["raw_values"]],
                "defaultHeaderRow": first["row_number"],
            }
        )
    return metadata


def mapping_index(value, headers: list, field: str) -> int:
    if isinstance(value, bool):
        raise RosterImportError(f"columnMapping.{field} must identify a column.")
    if isinstance(value, int):
        index = value
    elif isinstance(value, str) and value.strip().isdigit():
        index = int(value.strip())
    elif isinstance(value, str):
        matches = [
            index
            for index, header in enumerate(headers)
            if _canonical_header(header) == _canonical_header(value)
        ]
        if len(matches) != 1:
            raise RosterImportError(
                f"columnMapping.{field} must match exactly one header or use a zero-based index."
            )
        index = matches[0]
    else:
        raise RosterImportError(f"columnMapping.{field} must identify a column.")
    if index < 0 or index >= len(headers) or index >= MAX_COLUMNS:
        raise RosterImportError(f"columnMapping.{field} is outside the available columns.")
    return index


def parse_defaults(value) -> dict:
    if value is None:
        return {"group": "", "weight": 1.0, "included": True}
    if not isinstance(value, dict):
        raise RosterImportError("defaults must be an object.")
    group_name = str(value.get("group", value.get("groupName", "")) or "").strip()
    if len(group_name) > 100:
        raise RosterImportError("defaults.group is too long (max 100).")
    try:
        weight = float(value.get("weight", 1.0))
    except (TypeError, ValueError) as exc:
        raise RosterImportError("defaults.weight must be between 0 and 1.") from exc
    if not math.isfinite(weight) or weight < 0 or weight > 1:
        raise RosterImportError("defaults.weight must be between 0 and 1.")
    included = parse_included(value.get("included", True), label="defaults.included")
    return {"group": group_name, "weight": weight, "included": included}


def parse_included(value, *, label="included") -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in {0, 1}:
        return bool(value)
    normalized = str(value or "").strip().lower()
    if normalized in {"1", "true", "yes", "y", "included", "include"}:
        return True
    if normalized in {"0", "false", "no", "n", "excluded", "exclude"}:
        return False
    raise RosterImportError(f"{label} must be true or false.")
