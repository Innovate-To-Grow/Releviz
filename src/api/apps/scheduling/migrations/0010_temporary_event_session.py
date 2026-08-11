import uuid

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0009_analytics_timestamps"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="TemporaryEventSession",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("secret_hash", models.CharField(max_length=64, unique=True)),
                ("expires_at", models.DateTimeField()),
                ("last_seen_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                ("ip_address", models.GenericIPAddressField(blank=True, null=True)),
                ("user_agent", models.CharField(blank=True, default="", max_length=255)),
                (
                    "invitation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="temporary_sessions",
                        to="scheduling.eventinvitation",
                    ),
                ),
                (
                    "member",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="temporary_event_sessions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "participant",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="temporary_sessions",
                        to="scheduling.participant",
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["member", "revoked_at", "expires_at"],
                        name="tmp_session_member_exp_idx",
                    ),
                    models.Index(
                        fields=["participant", "revoked_at", "expires_at"],
                        name="tmp_session_part_exp_idx",
                    ),
                    models.Index(
                        fields=["expires_at"],
                        name="tmp_session_expires_idx",
                    ),
                ],
            },
        )
    ]
