import logging

from django.db import transaction
from django.utils import timezone

from .logs import record_sync_failure
from .rows import build_header, build_row
from .sheets import MemberSyncError

logger = logging.getLogger(__name__)


def sync_members_to_sheet(*, sync_type: str = "full") -> int:
    from apps.authn.models import MemberSheetSyncConfig, MemberSheetSyncLog

    config = MemberSheetSyncConfig.load()
    if not config.is_configured:
        raise MemberSyncError("Member sheet sync is not configured or not enabled.")

    try:
        # A database row lock serializes full replacement across every worker,
        # unlike the former process-local threading guard.
        with transaction.atomic():
            config = MemberSheetSyncConfig.objects.select_for_update().get(
                pk=config.pk,
                is_enabled=True,
            )
            rows = _write_members(config)
            synced_at = timezone.now()
            MemberSheetSyncConfig.objects.filter(pk=config.pk).update(
                synced_at=synced_at,
                sync_count=len(rows),
                sync_error="",
                updated_at=synced_at,
            )
            MemberSheetSyncLog.objects.create(
                sync_type=sync_type,
                status=MemberSheetSyncLog.Status.SUCCESS,
                rows_written=len(rows),
            )
    except MemberSyncError as exc:
        record_sync_failure(config, str(exc), sync_type=sync_type)
        raise
    except Exception as exc:
        record_sync_failure(config, str(exc), sync_type=sync_type)
        raise MemberSyncError(f"Failed to write to Google Sheet: {exc}") from exc
    return len(rows)


def _write_members(config) -> list[list[str]]:
    from django.contrib.auth import get_user_model

    import apps.authn.services.members.sheet_sync as sync_api

    Member = get_user_model()
    members = list(Member.objects.all().prefetch_related("contact_emails", "contact_phones").order_by("date_joined"))
    rows = [build_row(member) for member in members]
    worksheet = sync_api._get_worksheet(config)
    worksheet.clear()
    worksheet.update([build_header()] + rows, value_input_option="USER_ENTERED")
    logger.info("Full member sync: %d rows written to sheet.", len(rows))
    return rows
