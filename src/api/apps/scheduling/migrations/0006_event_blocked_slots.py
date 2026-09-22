from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0005_merge_starting_availability_and_contact_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="event",
            name="blocked_slots",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
