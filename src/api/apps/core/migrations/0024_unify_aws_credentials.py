from django.db import migrations, models


def copy_aws_settings_forward(apps, schema_editor):
    """Copy SES keys/region and SNS SMS settings into AWSCredentialConfig."""
    AWSCredentialConfig = apps.get_model("core", "AWSCredentialConfig")
    EmailServiceConfig = apps.get_model("core", "EmailServiceConfig")
    SMSServiceConfig = apps.get_model("core", "SMSServiceConfig")

    email = (
        EmailServiceConfig.objects.filter(is_active=True).first()
        or EmailServiceConfig.objects.order_by("-updated_at").first()
    )
    sms = (
        SMSServiceConfig.objects.filter(is_active=True).first()
        or SMSServiceConfig.objects.order_by("-updated_at").first()
    )

    aws = (
        AWSCredentialConfig.objects.filter(is_active=True).first()
        or AWSCredentialConfig.objects.order_by("-updated_at").first()
    )
    if aws is None:
        ses_keys_present = bool(email and (email.ses_access_key_id or email.ses_secret_access_key))
        sns_settings_present = bool(sms and (sms.sns_region or sms.from_number))
        if not (ses_keys_present or sns_settings_present):
            return
        aws = AWSCredentialConfig.objects.create(name="Production", is_active=True)

    dirty = False

    # Pick the first non-empty region we can find. SES/SNS regions on the
    # legacy configs win over the default if AWSCredentialConfig is still
    # on the placeholder default.
    if aws.default_region in ("", "us-west-2"):
        candidate_region = (email.ses_region if email else "") or (sms.sns_region if sms else "")
        if candidate_region:
            aws.default_region = candidate_region
            dirty = True

    if email is not None:
        if not aws.access_key_id and email.ses_access_key_id:
            aws.access_key_id = email.ses_access_key_id
            dirty = True
        if not aws.secret_access_key and email.ses_secret_access_key:
            aws.secret_access_key = email.ses_secret_access_key
            dirty = True

    if sms is not None:
        if not aws.sms_from_number and sms.from_number:
            aws.sms_from_number = sms.from_number
            dirty = True
        if not aws.sms_message_template and sms.message_template:
            aws.sms_message_template = sms.message_template
            dirty = True

    if dirty:
        aws.save()


def copy_aws_settings_backward(apps, schema_editor):
    """Copy AWS service settings back onto Email/SMS configs (best-effort)."""
    AWSCredentialConfig = apps.get_model("core", "AWSCredentialConfig")
    EmailServiceConfig = apps.get_model("core", "EmailServiceConfig")
    SMSServiceConfig = apps.get_model("core", "SMSServiceConfig")

    aws = (
        AWSCredentialConfig.objects.filter(is_active=True).first()
        or AWSCredentialConfig.objects.order_by("-updated_at").first()
    )
    if aws is None:
        return

    email = (
        EmailServiceConfig.objects.filter(is_active=True).first()
        or EmailServiceConfig.objects.order_by("-updated_at").first()
    )
    if email is not None:
        if aws.access_key_id and not email.ses_access_key_id:
            email.ses_access_key_id = aws.access_key_id
        if aws.secret_access_key and not email.ses_secret_access_key:
            email.ses_secret_access_key = aws.secret_access_key
        if aws.default_region and not email.ses_region:
            email.ses_region = aws.default_region
        email.save()

    sms = (
        SMSServiceConfig.objects.filter(is_active=True).first()
        or SMSServiceConfig.objects.order_by("-updated_at").first()
    )
    if sms is not None:
        if aws.sms_message_template and not sms.message_template:
            sms.message_template = aws.sms_message_template
        if aws.default_region and not sms.sns_region:
            sms.sns_region = aws.default_region
        if aws.sms_from_number and not sms.from_number:
            sms.from_number = aws.sms_from_number
        sms.save()


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0023_smsserviceconfig_sns"),
    ]

    operations = [
        migrations.AddField(
            model_name="awscredentialconfig",
            name="sms_from_number",
            field=models.CharField(
                blank=True,
                default="",
                help_text="SNS-registered origination number in E.164 format (e.g. +12065551234).",
                max_length=20,
                verbose_name="SMS Origination Number",
            ),
        ),
        migrations.AddField(
            model_name="awscredentialconfig",
            name="sms_message_template",
            field=models.CharField(
                blank=True,
                default="",
                help_text="SMS body template. Must include {code}. Leave blank for the default message.",
                max_length=320,
                verbose_name="SMS OTP Message Template",
            ),
        ),
        migrations.AlterField(
            model_name="awscredentialconfig",
            name="access_key_id",
            field=models.CharField(
                blank=True,
                default="",
                help_text="AWS IAM access key ID (starts with AKIA…). Shared by SES, SNS, and Bedrock.",
                max_length=128,
                verbose_name="Access Key ID",
            ),
        ),
        migrations.AlterField(
            model_name="awscredentialconfig",
            name="default_region",
            field=models.CharField(
                blank=True,
                default="us-west-2",
                help_text="AWS region used by SES, SNS, and Bedrock.",
                max_length=32,
                verbose_name="AWS Region",
            ),
        ),
        migrations.RunPython(copy_aws_settings_forward, copy_aws_settings_backward),
        migrations.RemoveField(
            model_name="emailserviceconfig",
            name="ses_access_key_id",
        ),
        migrations.RemoveField(
            model_name="emailserviceconfig",
            name="ses_secret_access_key",
        ),
        migrations.RemoveField(
            model_name="emailserviceconfig",
            name="ses_region",
        ),
        migrations.RemoveField(
            model_name="smsserviceconfig",
            name="sns_region",
        ),
        migrations.RemoveField(
            model_name="smsserviceconfig",
            name="from_number",
        ),
        migrations.DeleteModel(
            name="SMSServiceConfig",
        ),
    ]
