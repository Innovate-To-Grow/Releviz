import uuid

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("authn", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddConstraint(
            model_name="emailauthchallenge",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "pending")),
                fields=("member", "purpose", "channel"),
                name="one_pending_auth_challenge",
            ),
        ),
        migrations.CreateModel(
            name="AuthRateLimitBucket",
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
                ("scope", models.CharField(max_length=64)),
                ("key_hash", models.CharField(max_length=64)),
                ("request_count", models.PositiveIntegerField(default=0)),
                ("window_started_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("blocked_until", models.DateTimeField(blank=True, null=True)),
            ],
            options={
                "ordering": ["-updated_at"],
                "indexes": [
                    models.Index(
                        fields=["scope", "blocked_until"],
                        name="authn_authr_scope_ce5d62_idx",
                    ),
                    models.Index(fields=["updated_at"], name="authn_authr_updated_308110_idx"),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("scope", "key_hash"),
                        name="unique_auth_rate_limit_bucket",
                    )
                ],
            },
        ),
        migrations.CreateModel(
            name="AuthSession",
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
                ("refresh_jti", models.CharField(max_length=255, unique=True)),
                (
                    "previous_refresh_jti",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                ("refresh_recovery_expires_at", models.DateTimeField(blank=True, null=True)),
                ("refresh_recovered_at", models.DateTimeField(blank=True, null=True)),
                ("expires_at", models.DateTimeField()),
                ("last_seen_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                (
                    "revoked_reason",
                    models.CharField(
                        blank=True,
                        choices=[
                            ("logout", "Logout"),
                            ("password_change", "Password change"),
                            ("password_reset", "Password reset"),
                            ("account_delete", "Account delete"),
                            ("session_revoke", "Session revoke"),
                            ("admin", "Administrator"),
                        ],
                        default="",
                        max_length=32,
                    ),
                ),
                ("ip_address", models.GenericIPAddressField(blank=True, null=True)),
                ("user_agent", models.CharField(blank=True, default="", max_length=255)),
                (
                    "member",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="auth_sessions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["member", "revoked_at", "expires_at"],
                        name="authn_auths_member__6a8e13_idx",
                    ),
                    models.Index(fields=["expires_at"], name="authn_auths_expires_8594c4_idx"),
                ],
            },
        ),
    ]
