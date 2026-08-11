import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0011_roster_scaling"),
    ]

    operations = [
        migrations.CreateModel(
            name="EventResultInvalidation",
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
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("processed_at", models.DateTimeField(blank=True, null=True)),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="result_invalidations",
                        to="scheduling.event",
                    ),
                ),
            ],
            options={"ordering": ["created_at"]},
        ),
        migrations.CreateModel(
            name="RosterBulkUpdateReceipt",
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
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("idempotency_key", models.UUIDField()),
                ("request_fingerprint", models.CharField(max_length=64)),
                ("matched_count", models.PositiveIntegerField(default=0)),
                ("updated_count", models.PositiveIntegerField(default=0)),
                ("results_revision", models.PositiveBigIntegerField()),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="roster_bulk_update_receipts",
                        to="scheduling.event",
                    ),
                ),
            ],
        ),
        migrations.AddIndex(
            model_name="eventresultinvalidation",
            index=models.Index(
                fields=["event", "processed_at", "created_at"],
                name="result_inval_event_pending_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="rosterbulkupdatereceipt",
            constraint=models.UniqueConstraint(
                fields=("event", "idempotency_key"),
                name="one_roster_bulk_update_receipt_per_key",
            ),
        ),
        migrations.AddConstraint(
            model_name="rosterbulkupdatereceipt",
            constraint=models.CheckConstraint(
                condition=models.Q(("results_revision__gte", 1)),
                name="roster_bulk_receipt_revision_positive",
            ),
        ),
    ]
