"""JSON payload builders for the scheduling API.

These are plain functions rather than DRF serializer classes: the scheduling
endpoints validate input inline and only need one-way, camelCase output shapes.
"""

from __future__ import annotations

from django.db.models import Count

from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest
from apps.mail.services import email_delivery_summary
from apps.scheduling.models import (
    EventInvitation,
    RosterImportBatch,
    RosterImportReceipt,
    RosterImportRow,
)
from apps.scheduling.services.roster_imports import display_cell
from apps.scheduling.services.slots import api_slot_groups, event_slot_count, format_time_value

_INVITATION_NOT_PROVIDED = object()


def api_event(event, *, include_slot_groups=True) -> dict:
    final_meeting = getattr(event, "final_meeting", None)
    data = {
        "code": event.code,
        "name": event.name,
        "startTime": format_time_value(event.start_minutes),
        "endTime": format_time_value(event.end_minutes),
        "slotMinutes": event.slot_minutes,
        "slotCount": event_slot_count(event),
        "crossesMidnight": event.spans_next_day,
        "days": event.days,
        "mode": event.mode,
        "location": event.location,
        "organizerUserId": str(event.organizer_id),
        "participantViewPermission": event.participant_view_permission,
        "daySelectionType": event.day_selection_type,
        "responseDeadline": (
            event.response_deadline.isoformat() if event.response_deadline else None
        ),
        "timezone": event.timezone,
        "remindersEnabled": event.reminders_enabled,
        "reminderHoursBefore": event.reminder_hours_before,
        "accessMode": getattr(event, "access_mode", "invite_only"),
        "meetingDurationMinutes": getattr(event, "meeting_duration_minutes", event.slot_minutes),
        "resultsRevision": getattr(event, "results_revision", 1),
        "status": event.status,
        "version": event.version,
        "openedAt": event.opened_at.isoformat() if event.opened_at else None,
        "finalizedAt": event.finalized_at.isoformat() if event.finalized_at else None,
        "closedAt": event.closed_at.isoformat() if event.closed_at else None,
        "archivedAt": event.archived_at.isoformat() if event.archived_at else None,
        "createdAt": event.created_at.isoformat(),
        "finalMeeting": (
            api_final_meeting(final_meeting)
            if final_meeting is not None and final_meeting.active
            else None
        ),
    }
    if include_slot_groups:
        data["slotGroups"] = api_slot_groups(event)
    if event.specific_dates:
        data["specificDates"] = event.specific_dates
    return data


def api_final_meeting(final_meeting, *, include_attendance=False) -> dict:
    data = {
        "startsAt": final_meeting.starts_at.isoformat(),
        "endsAt": final_meeting.ends_at.isoformat(),
        "timezone": final_meeting.timezone,
        "channel": final_meeting.channel,
        "location": final_meeting.location,
        "calendarUid": final_meeting.calendar_uid,
        "calendarSequence": final_meeting.calendar_sequence,
        "confirmedAt": final_meeting.confirmed_at.isoformat(),
        "active": final_meeting.active,
    }
    if include_attendance:
        data["attendance"] = final_meeting.attendance_snapshot
    return data


def api_participant(
    participant,
    *,
    organizer_private=False,
    invitation=_INVITATION_NOT_PROVIDED,
) -> dict:
    data = {
        "id": str(participant.member_id),
        "user_id": str(participant.member_id),
        "event_id": str(participant.event.event_id),
        "name": participant.participant_name,
        "availabilityInperson": participant.availability_inperson,
        "availabilityVirtual": participant.availability_virtual,
        "submitted": 1 if participant.submitted else 0,
        "hidden": 1 if participant.hidden else 0,
        "group_name": participant.group_name,
        "sort_order": participant.sort_order,
        "version": participant.version,
        "created_at": participant.created_at.isoformat(),
    }
    if not organizer_private:
        return data

    member = participant.member
    member_email = str(member.email or "").strip().lower()
    if not member_email:
        member_email = member.get_primary_email().strip().lower()
    if invitation is _INVITATION_NOT_PROVIDED:
        invitation = (
            participant.event.invitations.filter(member_id=participant.member_id)
            .order_by("-created_at")
            .first()
        )
        if invitation is None:
            if member_email:
                invitation = participant.event.invitations.filter(
                    email__iexact=member_email,
                ).first()

    private_email = (
        str(invitation.email or "").strip().lower() if invitation is not None else member_email
    )

    account_access = getattr(member, "access_level", "full")
    if participant.submitted or (invitation is not None and invitation.status == "submitted"):
        invitation_status = "submitted"
    elif invitation is None or invitation.first_sent_at is None:
        invitation_status = "not_sent"
    elif invitation.opened_at is not None or invitation.status in {
        "opened",
        "joined",
        "draft_saved",
    }:
        invitation_status = "opened"
    else:
        invitation_status = "invited"

    data.update(
        {
            "accountAccess": account_access,
            "email": private_email,
            "invitationStatus": invitation_status,
            "canOrganizerEditAvailability": account_access == "temporary",
        }
    )
    return data


def participant_summary(participant) -> dict:
    """Roster-row shape for a participant annotated by ``services.roster``."""

    account_access = getattr(participant.member, "access_level", "full")
    return {
        "id": str(participant.pk),
        "participantId": str(participant.pk),
        "memberId": str(participant.member_id),
        "name": participant.participant_name,
        "email": str(getattr(participant, "roster_email", "") or "").lower(),
        "group": participant.group_name or "",
        "weight": float(getattr(participant, "roster_weight", 1.0)),
        "included": bool(getattr(participant, "roster_included", True)),
        "submitted": participant.submitted,
        "accountAccess": account_access,
        "canOrganizerEditAvailability": account_access == "temporary",
        "invitationStatus": getattr(participant, "roster_invitation_status", "not_sent"),
        "version": participant.version,
    }


def api_weight(weight) -> dict:
    return {
        "participant_id": str(weight.participant.member_id),
        "participant_name": weight.participant.participant_name,
        "weight": float(weight.weight),
        "included": 1 if weight.included else 0,
    }


def api_invitation(invitation: EventInvitation) -> dict:
    status_label = dict(EventInvitation.Status.choices).get(
        invitation.status,
        invitation.status.replace("_", " ").title(),
    )
    return {
        "id": invitation.pk,
        "email": invitation.email,
        "memberId": str(invitation.member_id) if invitation.member_id else None,
        "status": invitation.status,
        "statusLabel": status_label,
        "firstSentAt": (invitation.first_sent_at.isoformat() if invitation.first_sent_at else None),
        "lastSentAt": invitation.last_sent_at.isoformat() if invitation.last_sent_at else None,
        "reminderSentAt": invitation.reminder_sent_at.isoformat()
        if invitation.reminder_sent_at
        else None,
        "acceptedAt": invitation.accepted_at.isoformat() if invitation.accepted_at else None,
        "openedAt": invitation.opened_at.isoformat() if invitation.opened_at else None,
        "joinedAt": invitation.joined_at.isoformat() if invitation.joined_at else None,
        "draftSavedAt": (
            invitation.draft_saved_at.isoformat() if invitation.draft_saved_at else None
        ),
        "submittedAt": invitation.submitted_at.isoformat() if invitation.submitted_at else None,
        "awaitingReminder": bool(
            invitation.event.reminders_enabled
            and invitation.status != EventInvitation.Status.SUBMITTED
            and invitation.last_sent_at
            and not invitation.reminder_sent_at
        ),
        "customMessage": invitation.custom_message,
    }


def email_delivery_request_payload(
    request_record: EmailDeliveryRequest | None,
    *,
    jobs=None,
) -> dict | None:
    if request_record is None:
        return None
    delivery_jobs = list(jobs) if jobs is not None else list(request_record.jobs.all())
    return {
        "id": str(request_record.pk),
        "operation": request_record.operation,
        "recipientCount": request_record.recipient_count,
        "enqueued": request_record.created_job_count,
        "createdAt": request_record.created_at.isoformat(),
        "updatedAt": request_record.updated_at.isoformat(),
        "delivery": email_delivery_summary(delivery_jobs),
    }


def delivery_request_status_payload(request_record: EmailDeliveryRequest) -> dict:
    """Same shape as ``email_delivery_request_payload``, counted in the database.

    Use this when the jobs are not already in memory: it aggregates statuses with
    one GROUP BY instead of loading every job row.
    """

    status_counts = {
        row["status"]: row["total"]
        for row in request_record.jobs.values("status").annotate(total=Count("pk"))
    }
    return {
        "id": str(request_record.pk),
        "operation": request_record.operation,
        "recipientCount": request_record.recipient_count,
        "enqueued": request_record.created_job_count,
        "createdAt": request_record.created_at.isoformat(),
        "updatedAt": request_record.updated_at.isoformat(),
        "delivery": {
            "total": sum(status_counts.values()),
            "pending": status_counts.get(EmailDeliveryJob.Status.PENDING, 0),
            "processing": status_counts.get(EmailDeliveryJob.Status.PROCESSING, 0),
            "retry": status_counts.get(EmailDeliveryJob.Status.RETRY, 0),
            "sent": status_counts.get(EmailDeliveryJob.Status.SENT, 0),
            "permanentFailure": status_counts.get(
                EmailDeliveryJob.Status.PERMANENT_FAILURE,
                0,
            ),
            "canceled": status_counts.get(EmailDeliveryJob.Status.CANCELED, 0),
        },
    }


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
