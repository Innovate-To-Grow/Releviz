from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0022_remove_awscredentialconfig_default_model_id"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="smsserviceconfig",
            name="account_sid",
        ),
        migrations.RemoveField(
            model_name="smsserviceconfig",
            name="auth_token",
        ),
        migrations.RemoveField(
            model_name="smsserviceconfig",
            name="verify_sid",
        ),
        migrations.AddField(
            model_name="smsserviceconfig",
            name="message_template",
            field=models.CharField(
                blank=True,
                default="",
                help_text="SMS body template. Must include {code}. Leave blank for the default message.",
                max_length=320,
                verbose_name="OTP Message Template",
            ),
        ),
        migrations.AddField(
            model_name="smsserviceconfig",
            name="sns_region",
            field=models.CharField(
                blank=True,
                default="",
                help_text="AWS region for SNS SMS. Leave blank to use the shared AWS credential region.",
                max_length=32,
                verbose_name="SNS Region",
            ),
        ),
        migrations.AlterField(
            model_name="smsserviceconfig",
            name="from_number",
            field=models.CharField(
                blank=True,
                default="",
                help_text="SNS-registered origination number in E.164 format (e.g. +12065551234).",
                max_length=20,
                verbose_name="Origination Phone Number",
            ),
        ),
    ]
