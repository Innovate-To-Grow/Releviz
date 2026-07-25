import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

import apps.scheduling.validators


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0004_event_lifecycle_and_versions"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="event",
            name="timezone",
            field=models.CharField(
                default="UTC",
                max_length=64,
                validators=[apps.scheduling.validators.validate_iana_timezone],
            ),
        ),
        migrations.CreateModel(
            name="FinalMeeting",
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
                ("starts_at", models.DateTimeField()),
                ("ends_at", models.DateTimeField()),
                (
                    "timezone",
                    models.CharField(
                        max_length=64,
                        validators=[apps.scheduling.validators.validate_iana_timezone],
                    ),
                ),
                (
                    "channel",
                    models.CharField(
                        choices=[("inperson", "In person"), ("virtual", "Virtual")],
                        max_length=16,
                    ),
                ),
                ("location", models.CharField(blank=True, default="", max_length=500)),
                ("calendar_uid", models.CharField(max_length=255, unique=True)),
                ("calendar_sequence", models.PositiveIntegerField(default=0)),
                ("attendance_snapshot", models.JSONField(default=dict)),
                ("confirmed_at", models.DateTimeField()),
                ("active", models.BooleanField(default=True)),
                ("canceled_at", models.DateTimeField(blank=True, null=True)),
                (
                    "confirmed_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="confirmed_final_meetings",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "event",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="final_meeting",
                        to="scheduling.event",
                    ),
                ),
            ],
            options={"ordering": ["-confirmed_at"]},
        ),
        migrations.CreateModel(
            name="FinalizationRequest",
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
                ("meeting_sequence", models.PositiveIntegerField()),
                ("resulting_event_version", models.PositiveBigIntegerField()),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="finalization_requests",
                        to="scheduling.event",
                    ),
                ),
                (
                    "final_meeting",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="confirmation_requests",
                        to="scheduling.finalmeeting",
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.AddIndex(
            model_name="finalmeeting",
            index=models.Index(
                fields=["active", "starts_at"],
                name="scheduling__active_0364d7_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="finalmeeting",
            constraint=models.CheckConstraint(
                condition=models.Q(ends_at__gt=models.F("starts_at")),
                name="final_meeting_ends_after_start",
            ),
        ),
        migrations.AddConstraint(
            model_name="finalizationrequest",
            constraint=models.UniqueConstraint(
                fields=("event", "idempotency_key"),
                name="one_finalization_request_per_key",
            ),
        ),
        migrations.AddConstraint(
            model_name="finalizationrequest",
            constraint=models.CheckConstraint(
                condition=models.Q(resulting_event_version__gte=1),
                name="finalization_event_version_is_positive",
            ),
        ),
    ]
