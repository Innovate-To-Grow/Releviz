from django.db import migrations, models


def normalize_active_configs(apps, schema_editor):
    for model_name in (
        "AWSCredentialConfig",
        "GoogleCredentialConfig",
        "EmailServiceConfig",
        "GmailAccessAccount",
    ):
        Config = apps.get_model("core", model_name)
        # Preserve the pre-migration loader exactly once: it selected the first
        # active row by PK, or the most recently updated row when none was active.
        active = Config.objects.filter(is_active=True).order_by("pk")
        keep = active.first()
        if keep is None:
            keep = Config.objects.order_by("-updated_at", "-pk").first()
            if keep is not None:
                Config.objects.filter(pk=keep.pk).update(is_active=True)
        elif keep is not None:
            active.exclude(pk=keep.pk).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0027_backgroundjob"),
    ]

    operations = [
        migrations.RunPython(normalize_active_configs, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="awscredentialconfig",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_active", True)),
                fields=("is_active",),
                name="core_one_active_aws_config",
            ),
        ),
        migrations.AddConstraint(
            model_name="googlecredentialconfig",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_active", True)),
                fields=("is_active",),
                name="core_one_active_google_config",
            ),
        ),
        migrations.AddConstraint(
            model_name="emailserviceconfig",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_active", True)),
                fields=("is_active",),
                name="core_one_active_email_config",
            ),
        ),
        migrations.AddConstraint(
            model_name="gmailaccessaccount",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_active", True)),
                fields=("is_active",),
                name="core_one_active_gmail_account",
            ),
        ),
    ]
