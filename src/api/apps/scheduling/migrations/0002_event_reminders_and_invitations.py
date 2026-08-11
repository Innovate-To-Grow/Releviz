import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="event",
            name="reminder_hours_before",
            field=models.PositiveSmallIntegerField(default=24),
        ),
        migrations.AddField(
            model_name="event",
            name="reminders_enabled",
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name="event",
            name="response_deadline",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.CreateModel(
            name="EventInvitation",
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
                ("email", models.EmailField(max_length=254)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("invited", "Invited"),
                            ("accepted", "Accepted"),
                            ("submitted", "Submitted"),
                        ],
                        default="invited",
                        max_length=16,
                    ),
                ),
                ("last_sent_at", models.DateTimeField(blank=True, null=True)),
                ("reminder_sent_at", models.DateTimeField(blank=True, null=True)),
                ("accepted_at", models.DateTimeField(blank=True, null=True)),
                ("custom_message", models.TextField(blank=True, default="")),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="invitations",
                        to="scheduling.event",
                    ),
                ),
                (
                    "invited_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="sent_event_invitations",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "member",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="event_invitations",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["email"],
                "indexes": [
                    models.Index(fields=["email"], name="scheduling__email_39f572_idx"),
                    models.Index(fields=["status"], name="scheduling__status_7dc7be_idx"),
                    models.Index(fields=["last_sent_at"], name="scheduling__last_se_af9ba0_idx"),
                    models.Index(
                        fields=["reminder_sent_at"], name="scheduling__reminde_f174ad_idx"
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("event", "email"),
                        name="one_invitation_per_event_email",
                    )
                ],
            },
        ),
    ]
