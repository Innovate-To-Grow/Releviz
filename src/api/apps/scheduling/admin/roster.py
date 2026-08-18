"""Admin for roster import batches, rows, and receipts."""

from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.scheduling.models import RosterImportBatch, RosterImportReceipt, RosterImportRow


@admin.register(RosterImportBatch)
class RosterImportBatchAdmin(ModelAdmin):
    list_display = ("event", "source_type", "status", "created_by", "expires_at", "created_at")
    list_filter = ("source_type", "status")
    search_fields = ("event__code", "source_label")


@admin.register(RosterImportRow)
class RosterImportRowAdmin(ModelAdmin):
    list_display = ("batch", "worksheet", "row_number", "selected", "duplicate_status")
    list_filter = ("selected", "duplicate_status")
    search_fields = ("batch__event__code", "name", "email")


@admin.register(RosterImportReceipt)
class RosterImportReceiptAdmin(ModelAdmin):
    list_display = ("event", "mode", "imported_count", "committed_by", "committed_at")
    list_filter = ("mode",)
    search_fields = ("event__code", "idempotency_key")
    exclude = ("request_fingerprint",)
