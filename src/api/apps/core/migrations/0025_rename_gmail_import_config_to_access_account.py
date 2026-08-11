from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0024_unify_aws_credentials"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="GmailImportConfig",
            new_name="GmailAccessAccount",
        ),
        migrations.AlterModelOptions(
            name="gmailaccessaccount",
            options={
                "verbose_name": "Gmail Access Account",
                "verbose_name_plural": "Gmail Access Accounts",
            },
        ),
        migrations.AlterField(
            model_name="gmailaccessaccount",
            name="name",
            field=models.CharField(
                default="Default",
                help_text="A label to identify this account (e.g. 'Production Gmail Access').",
                max_length=128,
                verbose_name="Config Name",
            ),
        ),
    ]
