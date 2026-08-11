"""Replace plain-text secret_access_key with encrypted_secret_access_key."""

from django.db import migrations, models

from apps.core.services.aws.crypto import encrypt_secret


def encrypt_existing_secrets(apps, schema_editor):
    """Encrypt any plain-text secret access keys that exist in the old column."""
    AWSCredentialConfig = apps.get_model("core", "AWSCredentialConfig")
    for config in AWSCredentialConfig.objects.all():
        if config.secret_access_key:
            config.encrypted_secret_access_key = encrypt_secret(config.secret_access_key)
            config.save(update_fields=["encrypted_secret_access_key"])


def noop_reverse(apps, schema_editor):
    """Cannot reverse encryption — data is intentionally one-way."""


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="awscredentialconfig",
            name="encrypted_secret_access_key",
            field=models.TextField(
                blank=True,
                default="",
                help_text="AWS IAM secret access key, encrypted at rest with Fernet.",
                verbose_name="Encrypted Secret Access Key",
            ),
        ),
        migrations.RunPython(encrypt_existing_secrets, noop_reverse),
        migrations.RemoveField(
            model_name="awscredentialconfig",
            name="secret_access_key",
        ),
    ]
