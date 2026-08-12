from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0001_initial"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="awscredentialconfig",
            options={
                "verbose_name": "AWS Credential",
                "verbose_name_plural": "AWS Credentials",
            },
        ),
    ]
