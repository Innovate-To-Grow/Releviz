from django.utils import timezone


def record_sync_failure(config, error_message: str, *, sync_type: str) -> None:
    from apps.authn.models import MemberSheetSyncLog

    config.synced_at = timezone.now()
    config.sync_error = error_message
    config.save(update_fields=["synced_at", "sync_error", "updated_at"])

    MemberSheetSyncLog.objects.create(
        sync_type=sync_type,
        status=MemberSheetSyncLog.Status.FAILED,
        rows_written=0,
        error_message=error_message,
    )
