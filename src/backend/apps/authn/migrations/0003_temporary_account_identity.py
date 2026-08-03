from django.db import migrations, models


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
