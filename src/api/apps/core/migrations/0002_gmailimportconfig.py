from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="GmailImportConfig",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "name",
                    models.CharField(
                        default="Default",
                        help_text="A label to identify this configuration (e.g. 'Production Gmail Import').",
                        max_length=128,
                        verbose_name="Config Name",
                    ),
                ),
                (
                    "is_active",
                    models.BooleanField(
                        default=False,
                        help_text="Only one config can be active. Activating this will deactivate others.",
                        verbose_name="Active",
                    ),
                ),
                (
                    "imap_host",
                    models.CharField(
                        blank=True,
                        default="imap.gmail.com",
                        max_length=254,
                        verbose_name="IMAP Host",
                    ),
                ),
                (
                    "gmail_username",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="The Gmail account used to log in over IMAP and read sent messages.",
                        max_length=254,
                        verbose_name="Gmail Username",
                    ),
                ),
                (
                    "gmail_password",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="Gmail app password used for IMAP login.",
                        max_length=256,
                        verbose_name="Gmail Password",
                    ),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "Gmail Import Config",
                "verbose_name_plural": "Gmail Import Configs",
            },
        ),
    ]
