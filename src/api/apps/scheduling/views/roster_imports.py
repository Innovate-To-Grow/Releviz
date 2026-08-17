"""Staged roster import endpoints: upload, remap, review rows, then commit."""

from __future__ import annotations

from rest_framework.response import Response

from apps.scheduling.serializers import (
    api_event,
    email_delivery_request_payload,
    roster_import_payload,
    roster_import_receipt_payload,
    roster_import_row_payload,
)
from apps.scheduling.services.roster_imports import (
    RosterImportError,
    cancel_roster_import,
    commit_roster_import,
    create_roster_import,
    expire_roster_import_preview,
    update_roster_import,
)
from apps.scheduling.views.helpers import (
    PrivateAPIView,
    page_payload,
    parse_pagination,
    roster_batch_for_event,
    roster_error_response,
    roster_event_for_organizer,
    roster_write_error_response,
)


class RosterImportCollectionView(PrivateAPIView):
    def post(self, request):
        event, error = roster_event_for_organizer(request)
        if error:
            return error
        write_error = roster_write_error_response(event)
        if write_error:
            return write_error
        try:
            batch = create_roster_import(
                event=event,
                created_by=request.user,
                uploaded_file=request.FILES.get("file"),
                pasted_text=request.data.get("pastedText", request.data.get("content")),
                requested_source=str(request.data.get("sourceType") or "").strip().lower(),
            )
        except RosterImportError as exc:
            return roster_error_response(exc)
        return Response({"import": roster_import_payload(batch)}, status=201)


class RosterImportDetailView(PrivateAPIView):
    def put(self, request, import_id):
        event, error = roster_event_for_organizer(request)
        if error:
            return error
        write_error = roster_write_error_response(event)
        if write_error:
            return write_error
        batch = roster_batch_for_event(event, import_id)
        if batch is None:
            return Response({"error": "Roster import not found"}, status=404)
        try:
            batch = update_roster_import(batch=batch, data=request.data)
        except RosterImportError as exc:
            return roster_error_response(exc)
        return Response({"import": roster_import_payload(batch)})

    def delete(self, request, import_id):
        event, error = roster_event_for_organizer(request)
        if error:
            return error
        batch = roster_batch_for_event(event, import_id)
        if batch is None:
            return Response({"error": "Roster import not found"}, status=404)
        if expire_roster_import_preview(batch):
            return Response({"error": "This import preview has expired."}, status=410)
        try:
            batch = cancel_roster_import(batch)
        except RosterImportError as exc:
            return roster_error_response(exc)
        return Response({"importId": str(batch.pk), "status": batch.status})


class RosterImportRowsView(PrivateAPIView):
    def get(self, request, import_id):
        event, error = roster_event_for_organizer(request)
        if error:
            return error
        batch = roster_batch_for_event(event, import_id)
        if batch is None:
            return Response({"error": "Roster import not found"}, status=404)
        if expire_roster_import_preview(batch):
            return Response({"error": "This import preview has expired."}, status=410)
        try:
            page, page_size = parse_pagination(request)
        except RosterImportError as exc:
            return roster_error_response(exc)
        rows = batch.rows.filter(
            worksheet=batch.selected_worksheet,
            row_number__gt=batch.header_row,
        ).order_by("row_number")
        total = rows.count()
        offset = (page - 1) * page_size
        return Response(
            {
                "import": roster_import_payload(batch),
                "rows": [
                    roster_import_row_payload(row) for row in rows[offset : offset + page_size]
                ],
                "pagination": page_payload(
                    page=page,
                    page_size=page_size,
                    total=total,
                ),
            }
        )


class RosterImportCommitView(PrivateAPIView):
    def post(self, request, import_id):
        event, error = roster_event_for_organizer(request)
        if error:
            return error
        write_error = roster_write_error_response(event)
        if write_error:
            return write_error
        try:
            receipt, idempotent, delivery_request, auto_invited_count = commit_roster_import(
                event=event,
                batch_id=import_id,
                organizer=request.user,
                data=request.data,
            )
        except RosterImportError as exc:
            return roster_error_response(exc)
        receipt.event.refresh_from_db()
        return Response(
            {
                "receipt": roster_import_receipt_payload(receipt),
                "idempotent": idempotent,
                "event": api_event(receipt.event),
                "deliveryRequest": email_delivery_request_payload(delivery_request),
                "autoInvitedCount": auto_invited_count,
            },
            status=200 if idempotent else 201,
        )
