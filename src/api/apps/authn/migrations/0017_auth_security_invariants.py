import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
from django.utils import timezone


def normalize_singletons(apps, schema_editor):
    RSAKeypair = apps.get_model("authn", "RSAKeypair")
    MemberSheetSyncConfig = apps.get_model("authn", "MemberSheetSyncConfig")
    now = timezone.now()

    active_names = RSAKeypair.objects.filter(is_active=True).order_by().values_list("name", flat=True).distinct()
    for name in active_names.iterator():
        active = RSAKeypair.objects.filter(name=name, is_active=True).order_by(
            "-created_at",
            "-pk",
        )
        keep = active.first()
        if keep is not None:
            active.exclude(pk=keep.pk).update(
                is_active=False,
                rotated_at=now,
                updated_at=now,
            )

    enabled = MemberSheetSyncConfig.objects.filter(is_enabled=True).order_by(
        "-updated_at",
        "-created_at",
        "-pk",
    )
    keep = enabled.first()
    if keep is not None:
        enabled.exclude(pk=keep.pk).update(is_enabled=False, updated_at=now)


class Migration(migrations.Migration):
    dependencies = [
        ("authn", "0016_backfill_primary_email"),
    ]

    operations = [
        migrations.CreateModel(
            name="PhoneVerificationChallenge",
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
                (
                    "phone_number",
                    models.CharField(
                        db_index=True,
                        help_text="Destination phone in E.164 format.",
                        max_length=20,
                    ),
                ),
                (
                    "purpose",
                    models.CharField(
                        choices=[
                            ("phone_auth", "Phone authentication"),
                            ("contact_phone_verify", "Contact phone verification"),
                            ("password_reset", "Password reset"),
                            ("password_change", "Password change"),
                            ("event_registration", "Event registration"),
                        ],
                        default="phone_auth",
                        max_length=32,
                    ),
                ),
                (
                    "context_identifier",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="Purpose-specific resource or flow identifier bound to this challenge.",
                        max_length=255,
                    ),
                ),
                ("code_hash", models.CharField(max_length=255)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("consumed", "Consumed"),
                            ("expired", "Expired"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("attempts", models.PositiveSmallIntegerField(default=0)),
                ("max_attempts", models.PositiveSmallIntegerField(default=5)),
                ("expires_at", models.DateTimeField()),
                ("consumed_at", models.DateTimeField(blank=True, null=True)),
                ("send_reserved_at", models.DateTimeField(blank=True, null=True)),
                ("sent_at", models.DateTimeField(blank=True, null=True)),
                (
                    "member",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["phone_number", "purpose", "status"],
                        name="authn_phone_lookup_idx",
                    ),
                    models.Index(
                        fields=["expires_at"],
                        name="authn_phone_expiry_idx",
                    ),
                    models.Index(
                        fields=["phone_number", "send_reserved_at"],
                        name="authn_phone_send_cap_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        condition=models.Q(("status", "pending")),
                        fields=("phone_number", "purpose"),
                        name="one_pending_phone_challenge",
                    ),
                ],
            },
        ),
        migrations.RunPython(normalize_singletons, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="rsakeypair",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_active", True)),
                fields=("name",),
                name="authn_one_active_rsa_name",
            ),
        ),
        migrations.AddConstraint(
            model_name="membersheetsyncconfig",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_enabled", True)),
                fields=("is_enabled",),
                name="authn_one_enabled_member_sync",
            ),
        ),
        migrations.AlterField(
            model_name="membersheetsyncconfig",
            name="auto_sync_enabled",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Automatically sync to the sheet when a member, contact email, or contact phone "
                    "is created, updated, or deleted. Changes are coalesced through the durable "
                    "background-job queue."
                ),
                verbose_name="Auto Sync",
            ),
        ),
    ]
