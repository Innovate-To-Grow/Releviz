import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("authn", "0002_secure_auth_sessions"),
        ("messaging", "0002_email_delivery_jobs"),
        ("scheduling", "0005_event_timezone_finalmeeting_finalizationrequest"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="emaildeliveryjob",
            name="invitation",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="email_delivery_jobs",
                to="scheduling.eventinvitation",
            ),
        ),
        migrations.CreateModel(
            name="EmailDeliveryRequest",
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
                (
                    "operation",
                    models.CharField(
                        choices=[
                            ("invitation", "Invitation"),
                            ("reminder", "Reminder"),
                        ],
                        max_length=16,
                    ),
                ),
                ("idempotency_key", models.UUIDField()),
                ("request_fingerprint", models.CharField(max_length=64)),
                ("recipient_count", models.PositiveIntegerField(default=0)),
                ("created_job_count", models.PositiveIntegerField(default=0)),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="email_delivery_requests",
                        to="scheduling.event",
                    ),
                ),
                (
                    "jobs",
                    models.ManyToManyField(
                        blank=True,
                        related_name="delivery_requests",
                        to="messaging.emaildeliveryjob",
                    ),
                ),
                (
                    "requested_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="email_delivery_requests",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.AddIndex(
            model_name="emaildeliveryrequest",
            index=models.Index(
                fields=["event", "operation", "created_at"],
                name="messaging_e_event_i_550660_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="emaildeliveryrequest",
            constraint=models.UniqueConstraint(
                fields=("event", "operation", "idempotency_key"),
                name="one_email_delivery_request_per_key",
            ),
        ),
    ]
