import uuid

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models

MESSAGE_TYPE_CHOICES = [
    ("verification", "Verification"),
    ("welcome", "Welcome"),
    ("login_alert", "Login Alert"),
    ("invitation", "Invitation"),
    ("reminder", "Reminder"),
    ("final_confirmation", "Final Confirmation"),
    ("final_cancellation", "Final Cancellation"),
    ("test", "Test"),
]


class Migration(migrations.Migration):
    dependencies = [
        ("messaging", "0001_initial"),
        ("scheduling", "0005_event_timezone_finalmeeting_finalizationrequest"),
    ]

    operations = [
        migrations.AlterField(
            model_name="emailmessagelog",
            name="message_type",
            field=models.CharField(choices=MESSAGE_TYPE_CHOICES, max_length=32),
        ),
        migrations.CreateModel(
            name="EmailDeliveryJob",
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
                ("idempotency_key", models.CharField(max_length=255, unique=True)),
                (
                    "message_type",
                    models.CharField(choices=MESSAGE_TYPE_CHOICES, max_length=32),
                ),
                ("recipient", models.EmailField(max_length=254)),
                ("subject", models.CharField(max_length=255)),
                ("body", models.TextField()),
                ("html_body", models.TextField(blank=True, default="")),
                ("attachments", models.JSONField(default=list)),
                ("message_id", models.CharField(max_length=255, unique=True)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("processing", "Processing"),
                            ("retry", "Retry"),
                            ("sent", "Sent"),
                            ("permanent_failure", "Permanent Failure"),
                        ],
                        default="pending",
                        max_length=24,
                    ),
                ),
                ("attempt_count", models.PositiveSmallIntegerField(default=0)),
                ("max_attempts", models.PositiveSmallIntegerField(default=5)),
                (
                    "next_attempt_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("locked_at", models.DateTimeField(blank=True, null=True)),
                ("lock_token", models.UUIDField(blank=True, null=True)),
                ("sent_at", models.DateTimeField(blank=True, null=True)),
                (
                    "provider_message_id",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                ("last_error", models.TextField(blank=True, default="")),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="email_delivery_jobs",
                        to="scheduling.event",
                    ),
                ),
            ],
            options={"ordering": ["next_attempt_at", "created_at"]},
        ),
        migrations.AddField(
            model_name="emailmessagelog",
            name="delivery_job",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="message_logs",
                to="messaging.emaildeliveryjob",
            ),
        ),
        migrations.AddIndex(
            model_name="emaildeliveryjob",
            index=models.Index(
                fields=["status", "next_attempt_at"],
                name="messaging_e_status_22d4d4_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="emaildeliveryjob",
            index=models.Index(
                fields=["event", "message_type"],
                name="messaging_e_event_i_e73507_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="emaildeliveryjob",
            constraint=models.CheckConstraint(
                condition=models.Q(max_attempts__gte=1),
                name="email_job_max_attempts_is_positive",
            ),
        ),
    ]
