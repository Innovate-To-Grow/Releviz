from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0003_alter_rosterimportreceipt_batch"),
    ]

    operations = [
        migrations.AddField(
            model_name="event",
            name="blocked_slots",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
