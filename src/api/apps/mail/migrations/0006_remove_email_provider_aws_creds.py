from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("mail", "0005_final_delivery_requests"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="emailproviderconfig",
            name="aws_access_key_id",
        ),
        migrations.RemoveField(
            model_name="emailproviderconfig",
            name="aws_region",
        ),
        migrations.RemoveField(
            model_name="emailproviderconfig",
            name="encrypted_secret_access_key",
        ),
        migrations.AlterField(
            model_name="emailproviderconfig",
            name="from_email",
            field=models.EmailField(
                help_text="Verified SES sender address (e.g. noreply@example.com).",
                max_length=254,
                verbose_name="From Email",
            ),
        ),
        migrations.AlterField(
            model_name="emailproviderconfig",
            name="name",
            field=models.CharField(default="Default", max_length=120),
        ),
        migrations.AlterField(
            model_name="emailproviderconfig",
            name="reply_to_email",
            field=models.EmailField(
                blank=True,
                default="",
                help_text="Optional reply-to address for outgoing emails.",
                max_length=254,
                verbose_name="Reply-To Email",
            ),
        ),
    ]
