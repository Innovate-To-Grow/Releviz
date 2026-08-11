from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("authn", "0017_auth_security_invariants"),
    ]

    operations = [
        migrations.AddField(
            model_name="phoneverificationchallenge",
            name="verified_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RemoveConstraint(
            model_name="phoneverificationchallenge",
            name="one_pending_phone_challenge",
        ),
        migrations.AlterField(
            model_name="phoneverificationchallenge",
            name="status",
            field=models.CharField(
                choices=[
                    ("sending", "Sending"),
                    ("pending", "Pending"),
                    ("verified", "Verified"),
                    ("consumed", "Consumed"),
                    ("expired", "Expired"),
                ],
                default="pending",
                max_length=16,
            ),
        ),
        migrations.AddConstraint(
            model_name="phoneverificationchallenge",
            constraint=models.UniqueConstraint(
                condition=models.Q(status__in=["sending", "pending", "verified"]),
                fields=("phone_number", "purpose"),
                name="one_active_phone_challenge",
            ),
        ),
    ]
