"""Create, edit, expire, and cancel roster import previews."""

import math

from django.db import transaction
from django.utils import timezone

from apps.scheduling.models import Event, RosterImportBatch, RosterImportRow

from .errors import RosterImportError
from .limits import MAX_ROSTER_ROWS, PREVIEW_LIFETIME
from .mapping import (
    MAPPING_KEYS,
    auto_mapping,
    mapping_index,
    parse_defaults,
    parse_included,
    worksheet_metadata,
)
from .normalization import (
    active_rows,
    apply_duplicate_rules,
    normalize_import_batch,
    rows_summary,
    validate_identity_fields,
)
from .parsing import parse_roster_source


def _header_values(batch: RosterImportBatch, worksheet: str, header_row: int) -> list:
    row = batch.rows.filter(worksheet=worksheet, row_number=header_row).first()
    if row is None:
        raise RosterImportError("headerRow does not identify a non-empty row in the worksheet.")
    return row.raw_values


def create_roster_import(
    *,
    event: Event,
    created_by,
    uploaded_file=None,
    pasted_text=None,
    requested_source="",
) -> RosterImportBatch:
    source_type, source_label, raw_rows = parse_roster_source(
        uploaded_file=uploaded_file,
        pasted_text=pasted_text,
        requested_source=requested_source,
    )
    metadata = worksheet_metadata(raw_rows)
    selected = metadata[0]["name"] if len(metadata) == 1 else ""
    header_row = metadata[0]["defaultHeaderRow"] if selected else 1
    headers = metadata[0]["headers"] if selected else []
    mapping = auto_mapping(headers) if selected else {}
    with transaction.atomic():
        batch = RosterImportBatch.objects.create(
            event=event,
            created_by=created_by,
            source_type=source_type,
            source_label=source_label,
            worksheets=metadata,
            selected_worksheet=selected,
            header_row=header_row,
            column_mapping=mapping,
            defaults={"group": "", "weight": 1.0, "included": True},
            expires_at=timezone.now() + PREVIEW_LIFETIME,
        )
        RosterImportRow.objects.bulk_create(
            [
                RosterImportRow(
                    batch=batch,
                    worksheet=row["worksheet"],
                    row_number=row["row_number"],
                    raw_values=row["raw_values"],
                )
                for row in raw_rows
            ]
        )
        normalize_import_batch(batch)
    return batch


def update_roster_import(*, batch: RosterImportBatch, data) -> RosterImportBatch:
    with transaction.atomic():
        batch = RosterImportBatch.objects.select_for_update().get(pk=batch.pk)
        require_preview(batch)
        mapping_changed = False
        if "worksheet" in data:
            worksheet = str(data.get("worksheet") or "")
            if worksheet not in {item["name"] for item in batch.worksheets}:
                raise RosterImportError("worksheet was not found in this import.")
            batch.selected_worksheet = worksheet
            first_row = batch.rows.filter(worksheet=worksheet).order_by("row_number").first()
            if first_row is None:
                raise RosterImportError("worksheet contains no non-empty rows.")
            if "headerRow" not in data:
                batch.header_row = first_row.row_number
            mapping_changed = True
        if "headerRow" in data:
            header_row = data.get("headerRow")
            if isinstance(header_row, bool) or not isinstance(header_row, int) or header_row < 1:
                raise RosterImportError("headerRow must be a positive integer.")
            batch.header_row = header_row
            mapping_changed = True
        if not batch.selected_worksheet:
            raise RosterImportError("Select a worksheet before mapping columns.")
        headers = _header_values(batch, batch.selected_worksheet, batch.header_row)

        if "columnMapping" in data:
            supplied = data.get("columnMapping")
            if not isinstance(supplied, dict):
                raise RosterImportError("columnMapping must be an object.")
            unknown = set(supplied) - MAPPING_KEYS
            if unknown:
                raise RosterImportError(f"Unknown mapped field: {sorted(unknown)[0]}.")
            mapping = {
                field: mapping_index(value, headers, field)
                for field, value in supplied.items()
                if value is not None and value != ""
            }
            if "name" not in mapping or "email" not in mapping:
                raise RosterImportError("columnMapping must include name and email.")
            if len(set(mapping.values())) != len(mapping):
                raise RosterImportError("Each mapped field must use a different column.")
            batch.column_mapping = mapping
            mapping_changed = True
        elif mapping_changed:
            batch.column_mapping = auto_mapping(headers)

        if "defaults" in data:
            batch.defaults = parse_defaults(data.get("defaults"))
            mapping_changed = True
        batch.save(
            update_fields=[
                "selected_worksheet",
                "header_row",
                "column_mapping",
                "defaults",
                "updated_at",
            ]
        )
        if mapping_changed:
            normalize_import_batch(batch)
        if "rowUpdates" in data:
            _apply_row_updates(batch, data.get("rowUpdates"))
    return batch


def _apply_row_updates(batch: RosterImportBatch, updates) -> None:
    if not isinstance(updates, list):
        raise RosterImportError("rowUpdates must be an array.")
    if len(updates) > MAX_ROSTER_ROWS:
        raise RosterImportError(f"rowUpdates may contain at most {MAX_ROSTER_ROWS} rows.")
    identifiers = [str(item.get("id") or "") for item in updates if isinstance(item, dict)]
    if len(identifiers) != len(updates) or len(set(identifiers)) != len(identifiers):
        raise RosterImportError("Each rowUpdates entry must have a unique id.")
    all_rows = active_rows(batch)
    rows = {str(row.pk): row for row in all_rows if str(row.pk) in set(identifiers)}
    if len(rows) != len(updates):
        raise RosterImportError("A rowUpdates id does not belong to this preview.")

    for item in updates:
        row = rows[str(item["id"])]
        name = row.name
        email = row.email
        group_name = row.group_name
        if "name" in item:
            name = str(item.get("name") or "").strip()
        if "email" in item:
            email = str(item.get("email") or "").strip().lower()
        if "group" in item or "groupName" in item:
            group_name = str(item.get("group", item.get("groupName")) or "").strip()
        identity_errors = validate_identity_fields(name, email, group_name)
        row.name = name[:100]
        row.email = email[:254]
        row.group_name = group_name[:100]
        if "weight" in item:
            try:
                weight = float(item.get("weight"))
            except (TypeError, ValueError) as exc:
                raise RosterImportError("rowUpdates.weight must be between 0 and 1.") from exc
            if not math.isfinite(weight) or weight < 0 or weight > 1:
                raise RosterImportError("rowUpdates.weight must be between 0 and 1.")
            row.weight = weight
        if "included" in item:
            row.included = parse_included(item.get("included"), label="rowUpdates.included")
        if "selected" in item:
            row.selected = parse_included(item.get("selected"), label="rowUpdates.selected")
        row.validation_errors = identity_errors
        row.duplicate_status = RosterImportRow.DuplicateStatus.UNIQUE

    apply_duplicate_rules(all_rows)
    if rows_summary(all_rows)["valid"] > MAX_ROSTER_ROWS:
        raise RosterImportError(
            f"An import may contain at most {MAX_ROSTER_ROWS} valid participants."
        )
    RosterImportRow.objects.bulk_update(
        all_rows,
        [
            "name",
            "email",
            "group_name",
            "weight",
            "included",
            "selected",
            "validation_errors",
            "duplicate_status",
            "updated_at",
        ],
    )
    batch.summary = rows_summary(all_rows)
    batch.save(update_fields=["summary", "updated_at"])


def require_preview(batch: RosterImportBatch) -> None:
    if batch.status != RosterImportBatch.Status.PREVIEW:
        raise RosterImportError(
            f"This import is {batch.status} and can no longer be changed.",
            status_code=409,
        )
    if batch.expires_at <= timezone.now():
        scrub_batch(batch, RosterImportBatch.Status.EXPIRED)
        raise RosterImportError("This import preview has expired.", status_code=410)


def scrub_batch(batch: RosterImportBatch, status: str, *, summary=None) -> None:
    batch.rows.all().delete()
    batch.status = status
    batch.worksheets = []
    batch.selected_worksheet = ""
    batch.column_mapping = {}
    batch.defaults = {}
    batch.summary = summary or {}
    batch.failure_reason = ""
    batch.save(
        update_fields=[
            "status",
            "worksheets",
            "selected_worksheet",
            "column_mapping",
            "defaults",
            "summary",
            "failure_reason",
            "updated_at",
        ]
    )


def expire_roster_import_preview(batch: RosterImportBatch) -> bool:
    """Expire one requested preview without sweeping unrelated organizers' data."""

    with transaction.atomic():
        batch = RosterImportBatch.objects.select_for_update().get(pk=batch.pk)
        if batch.status == RosterImportBatch.Status.EXPIRED:
            return True
        if batch.status == RosterImportBatch.Status.PREVIEW and batch.expires_at <= timezone.now():
            scrub_batch(batch, RosterImportBatch.Status.EXPIRED)
            return True
    return False


def expire_stale_roster_imports(*, limit: int | None = None) -> int:
    stale_query = (
        RosterImportBatch.objects.filter(
            status=RosterImportBatch.Status.PREVIEW,
            expires_at__lte=timezone.now(),
        )
        .order_by("expires_at")
        .values_list("pk", flat=True)
    )
    stale = list(stale_query[:limit] if limit is not None else stale_query)
    for batch_id in stale:
        with transaction.atomic():
            batch = RosterImportBatch.objects.select_for_update().filter(pk=batch_id).first()
            if (
                batch is not None
                and batch.status == RosterImportBatch.Status.PREVIEW
                and batch.expires_at <= timezone.now()
            ):
                scrub_batch(batch, RosterImportBatch.Status.EXPIRED)
    return len(stale)


def cancel_roster_import(batch: RosterImportBatch) -> RosterImportBatch:
    with transaction.atomic():
        batch = RosterImportBatch.objects.select_for_update().get(pk=batch.pk)
        if batch.status == RosterImportBatch.Status.COMMITTED:
            raise RosterImportError("A committed import cannot be canceled.", status_code=409)
        if batch.status == RosterImportBatch.Status.CANCELED:
            return batch
        scrub_batch(batch, RosterImportBatch.Status.CANCELED)
    return batch
