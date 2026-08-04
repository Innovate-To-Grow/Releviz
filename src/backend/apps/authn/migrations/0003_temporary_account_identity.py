from django.db import migrations, models


def expire_duplicate_pending_challenges_for_rollback(apps, schema_editor):
    """Restore the pre-scope uniqueness invariant before reversing the migration."""

    EmailAuthChallenge = apps.get_model("authn", "EmailAuthChallenge")
    database_alias = schema_editor.connection.alias
    pending = (
        EmailAuthChallenge.objects.using(database_alias)
        .filter(status="pending")
        .order_by("member_id", "purpose", "channel", "-created_at", "-pk")
        .values_list("pk", "member_id", "purpose", "channel")
    )

    seen = set()
    duplicate_ids = []
    for challenge_id, member_id, purpose, channel in pending.iterator():
        identity = (member_id, purpose, channel)
        if identity in seen:
            duplicate_ids.append(challenge_id)
        else:
            seen.add(identity)

    if duplicate_ids:
        EmailAuthChallenge.objects.using(database_alias).filter(pk__in=duplicate_ids).update(
            status="expired"
        )


class Migration(migrations.Migration):
    dependencies = [
        ("authn", "0002_secure_auth_sessions"),
    ]

    operations = [
        migrations.AddField(
            model_name="member",
            name="access_level",
            field=models.CharField(
                choices=[("temporary", "Temporary"), ("full", "Full")],
                db_default="full",
                db_index=True,
                default="full",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="emailauthchallenge",
            name="scope_key",
            field=models.CharField(blank=True, db_default="", default="", max_length=255),
        ),
        migrations.RemoveConstraint(
            model_name="emailauthchallenge",
            name="one_pending_auth_challenge",
        ),
        migrations.RunPython(
            migrations.RunPython.noop,
            expire_duplicate_pending_challenges_for_rollback,
        ),
        migrations.AlterField(
            model_name="emailauthchallenge",
            name="purpose",
            field=models.CharField(
                choices=[
                    ("register", "Register"),
                    ("login", "Login"),
                    ("password_reset", "Password Reset"),
                    ("password_change", "Password Change"),
                    ("account_delete", "Account Delete"),
                    ("contact_email_verify", "Contact Email Verify"),
                    ("admin_login", "Admin Login"),
                    ("temp_event_access", "Temporary Event Access"),
                ],
                max_length=32,
            ),
        ),
        migrations.AddIndex(
            model_name="emailauthchallenge",
            index=models.Index(
                fields=["purpose", "scope_key", "status"],
                name="authn_chal_scope_status_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="emailauthchallenge",
            constraint=models.UniqueConstraint(
                condition=models.Q(status="pending"),
                fields=("member", "purpose", "channel", "scope_key"),
                name="one_pending_auth_challenge",
            ),
        ),
    ]
