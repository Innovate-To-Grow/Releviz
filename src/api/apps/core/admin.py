from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.core.models import FeedbackSubmission


@admin.register(FeedbackSubmission)
class FeedbackSubmissionAdmin(ModelAdmin):
    list_display = (
        "category",
        "status",
        "member",
        "consent_to_follow_up",
        "page_path",
        "created_at",
    )
    list_filter = ("category", "status", "consent_to_follow_up")
    search_fields = ("member__email", "member__first_name", "member__last_name")
    readonly_fields = (
        "category",
        "message",
        "page_path",
        "member",
        "consent_to_follow_up",
        "request_id",
        "created_at",
        "updated_at",
    )
