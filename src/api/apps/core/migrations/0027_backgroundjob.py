import django.utils.timezone
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0026_remove_emailserviceconfig_smtp_fields"),
    ]

    operations = [
        migrations.CreateModel(
            name="BackgroundJob",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at", models.DateTimeField(auto_now=True, db_index=True)),
                ("kind", models.CharField(db_index=True, max_length=80)),
                ("dedupe_key", models.CharField(max_length=255)),
                ("payload", models.JSONField(default=dict)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("processing", "Processing"),
                            ("retry", "Retry scheduled"),
                            ("succeeded", "Succeeded"),
                            ("failed", "Failed"),
                            ("uncertain", "Uncertain delivery"),
                            ("cancelled", "Cancelled"),
                        ],
                        db_index=True,
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("attempts", models.PositiveSmallIntegerField(default=0)),
                ("max_attempts", models.PositiveSmallIntegerField(default=5)),
                ("available_at", models.DateTimeField(db_index=True, default=django.utils.timezone.now)),
                ("claim_token", models.UUIDField(blank=True, editable=False, null=True)),
                ("claimed_at", models.DateTimeField(blank=True, editable=False, null=True)),
                ("provider_call_started_at", models.DateTimeField(blank=True, editable=False, null=True)),
                (
                    "can_retry_after_claim",
                    models.BooleanField(
                        default=True,
                        help_text=(
                            "Whether a stale claimed job is safe to retry. Disable for provider "
                            "deliveries whose outcome cannot be queried idempotently."
                        ),
                    ),
                ),
                ("completed_at", models.DateTimeField(blank=True, editable=False, null=True)),
                ("last_error", models.TextField(blank=True, default="", editable=False)),
            ],
            options={
                "ordering": ["available_at", "created_at"],
                "indexes": [
                    models.Index(
                        fields=["status", "available_at", "created_at"],
                        name="core_job_claim_idx",
                    ),
                    models.Index(
                        fields=["status", "claimed_at"],
                        name="core_job_stale_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("kind", "dedupe_key"),
                        name="unique_background_job_dedupe_key",
                    ),
                ],
            },
        ),
    ]
