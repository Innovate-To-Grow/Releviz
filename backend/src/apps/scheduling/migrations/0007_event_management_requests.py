import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0006_minute_slots_and_native_availability"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="EventDeletionRecord",
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
                ("event_id", models.UUIDField(unique=True)),
                ("code", models.CharField(max_length=16, unique=True)),
                ("idempotency_key", models.UUIDField()),
                ("request_fingerprint", models.CharField(max_length=64)),
                ("deleted_version", models.PositiveBigIntegerField()),
                (
                    "organizer",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="event_deletion_records",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="EventDuplicationRequest",
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
                ("source_version", models.PositiveBigIntegerField()),
                (
                    "duplicate_event",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="source_duplication_requests",
                        to="scheduling.event",
                    ),
                ),
                (
                    "requested_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="event_duplication_requests",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "source_event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="duplication_requests",
                        to="scheduling.event",
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.AddConstraint(
            model_name="eventdeletionrecord",
            constraint=models.UniqueConstraint(
                fields=("organizer", "idempotency_key"),
                name="one_event_deletion_per_member_key",
            ),
        ),
        migrations.AddConstraint(
            model_name="eventdeletionrecord",
            constraint=models.CheckConstraint(
                condition=models.Q(("deleted_version__gte", 1)),
                name="event_deletion_version_positive",
            ),
        ),
        migrations.AddConstraint(
            model_name="eventduplicationrequest",
            constraint=models.UniqueConstraint(
                fields=("source_event", "idempotency_key"),
                name="one_event_duplication_per_key",
            ),
        ),
        migrations.AddConstraint(
            model_name="eventduplicationrequest",
            constraint=models.CheckConstraint(
                condition=models.Q(("source_version__gte", 1)),
                name="event_duplication_source_version_positive",
            ),
        ),
    ]
