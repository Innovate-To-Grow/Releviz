import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("scheduling", "0002_event_reminders_and_invitations"),
    ]

    operations = [
        migrations.CreateModel(
            name="EmailProviderConfig",
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
                ("name", models.CharField(default="AWS SES", max_length=120)),
                ("is_active", models.BooleanField(default=True)),
                ("aws_region", models.CharField(default="us-west-2", max_length=64)),
                ("from_email", models.EmailField(max_length=254)),
                ("reply_to_email", models.EmailField(blank=True, default="", max_length=254)),
                ("aws_access_key_id", models.CharField(max_length=255)),
                ("encrypted_secret_access_key", models.TextField(blank=True, default="")),
                ("last_tested_at", models.DateTimeField(blank=True, null=True)),
                ("last_error", models.TextField(blank=True, default="")),
            ],
            options={
                "ordering": ["-is_active", "name", "-created_at"],
            },
        ),
        migrations.CreateModel(
            name="EmailMessageLog",
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
                    "message_type",
                    models.CharField(
                        choices=[
                            ("verification", "Verification"),
                            ("welcome", "Welcome"),
                            ("login_alert", "Login Alert"),
                            ("invitation", "Invitation"),
                            ("reminder", "Reminder"),
                            ("test", "Test"),
                        ],
                        max_length=32,
                    ),
                ),
                ("recipient", models.EmailField(max_length=254)),
                ("subject", models.CharField(max_length=255)),
                (
                    "status",
                    models.CharField(
                        choices=[("sent", "Sent"), ("failed", "Failed")],
                        max_length=16,
                    ),
                ),
                ("provider_message_id", models.CharField(blank=True, default="", max_length=255)),
                ("error", models.TextField(blank=True, default="")),
                (
                    "event",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="email_logs",
                        to="scheduling.event",
                    ),
                ),
                (
                    "invitation",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="email_logs",
                        to="scheduling.eventinvitation",
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["message_type", "status"], name="messaging_e_message_606b50_idx"
                    ),
                    models.Index(fields=["recipient"], name="messaging_e_recipie_2d8f66_idx"),
                    models.Index(fields=["created_at"], name="messaging_e_created_c6602a_idx"),
                ],
            },
        ),
    ]
