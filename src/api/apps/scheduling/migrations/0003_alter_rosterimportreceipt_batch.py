from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0002_event_status_active"),
    ]

    operations = [
        migrations.AlterField(
            model_name="rosterimportreceipt",
            name="batch",
            field=models.OneToOneField(
                on_delete=models.RESTRICT,
                related_name="receipt",
                to="scheduling.rosterimportbatch",
            ),
        ),
    ]
