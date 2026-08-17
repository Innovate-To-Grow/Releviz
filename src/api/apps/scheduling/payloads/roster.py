"""API payloads for roster imports."""

from apps.scheduling.models import RosterImportBatch, RosterImportReceipt, RosterImportRow
from apps.scheduling.services.roster_imports.mapping import display_cell


def roster_import_payload(batch: RosterImportBatch) -> dict:
    selected_metadata = next(
        (item for item in batch.worksheets if item.get("name") == batch.selected_worksheet),
        None,
    )
    headers = []
    if batch.selected_worksheet and batch.status == RosterImportBatch.Status.PREVIEW:
        header = batch.rows.filter(
            worksheet=batch.selected_worksheet,
            row_number=batch.header_row,
        ).first()
        if header is not None:
            headers = [display_cell(value) for value in header.raw_values]
    return {
        "id": str(batch.pk),
        "status": batch.status,
        "sourceType": batch.source_type,
        "fileName": batch.source_label or None,
        "worksheets": batch.worksheets,
        "selectedWorksheet": batch.selected_worksheet or None,
        "headerRow": batch.header_row,
        "headers": headers or (selected_metadata or {}).get("headers", []),
        "columnMapping": batch.column_mapping,
        "defaults": batch.defaults,
        "expiresAt": batch.expires_at.isoformat(),
        "summary": batch.summary,
    }


def roster_import_row_payload(row: RosterImportRow) -> dict:
    return {
        "id": str(row.pk),
        "rowNumber": row.row_number,
        "name": row.name,
        "email": row.email,
        "group": row.group_name,
        "weight": float(row.weight),
        "included": row.included,
        "selected": row.selected,
        "valid": not bool(row.validation_errors),
        "duplicate": row.duplicate_status,
        "errors": row.validation_errors,
    }


def roster_import_receipt_payload(receipt: RosterImportReceipt) -> dict:
    return {
        "id": str(receipt.pk),
        "mode": receipt.mode,
        "importedCount": receipt.imported_count,
        "createdCount": receipt.created_count,
        "updatedCount": receipt.updated_count,
        "resultsRevision": receipt.results_revision,
        "committedAt": receipt.committed_at.isoformat(),
    }
