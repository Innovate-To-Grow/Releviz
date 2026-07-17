import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("authn", "0002_secure_auth_sessions"),
        ("messaging", "0003_invitation_reminder_delivery"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="emaildeliveryjob",
            name="auth_challenge",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="delivery_job",
                to="authn.emailauthchallenge",
            ),
        ),
        migrations.AddField(
            model_name="emaildeliveryjob",
            name="auth_session",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="login_alert_delivery_job",
                to="authn.authsession",
            ),
        ),
        migrations.AddField(
            model_name="emaildeliveryjob",
            name="content_encrypted",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="emaildeliveryjob",
            name="member",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="email_delivery_jobs",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="emaildeliveryjob",
            name="event",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="email_delivery_jobs",
                to="scheduling.event",
            ),
        ),
        migrations.AlterField(
            model_name="emaildeliveryjob",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "Pending"),
                    ("processing", "Processing"),
                    ("retry", "Retry"),
                    ("sent", "Sent"),
                    ("permanent_failure", "Permanent Failure"),
                    ("canceled", "Canceled"),
                ],
                default="pending",
                max_length=24,
            ),
        ),
        migrations.AddIndex(
            model_name="emaildeliveryjob",
            index=models.Index(
                fields=["member", "message_type"],
                name="messaging_e_member__8b4ca8_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="emaildeliveryjob",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("event__isnull", False), ("member__isnull", False), _connector="OR"
                ),
                name="email_job_has_domain_owner",
            ),
        ),
    ]
