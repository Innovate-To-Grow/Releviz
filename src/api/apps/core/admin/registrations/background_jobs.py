from django.contrib import admin, messages
from unfold.decorators import action

from apps.core.models import BackgroundJob
from apps.core.services.background_jobs import retry_job

from ..common.base import ReadOnlyModelAdmin


@admin.register(BackgroundJob)
class BackgroundJobAdmin(ReadOnlyModelAdmin):
    list_display = (
        "kind",
        "dedupe_key",
        "status",
        "attempts",
        "available_at",
        "claimed_at",
        "updated_at",
    )
    list_filter = ("status", "kind", "can_retry_after_claim")
    search_fields = ("kind", "dedupe_key", "last_error")
    readonly_fields = (
        "id",
        "kind",
        "dedupe_key",
        "payload",
        "status",
        "attempts",
        "max_attempts",
        "available_at",
        "claim_token",
        "claimed_at",
        "provider_call_started_at",
        "can_retry_after_claim",
        "completed_at",
        "last_error",
        "created_at",
        "updated_at",
    )
    actions = ("retry_selected_jobs",)

    @action(description="Explicitly retry selected failed/uncertain jobs")
    def retry_selected_jobs(self, request, queryset):
        retried = 0
        for job in queryset:
            if retry_job(job):
                retried += 1
        if retried:
            self.message_user(request, f"Queued {retried} job(s) for explicit retry.", messages.SUCCESS)
        else:
            self.message_user(
                request,
                "No failed or uncertain jobs were selected.",
                messages.WARNING,
            )
