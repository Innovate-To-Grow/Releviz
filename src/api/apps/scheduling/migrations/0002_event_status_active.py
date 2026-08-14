from django.db import migrations, models


def require_empty_event_table(apps, schema_editor):
    Event = apps.get_model("scheduling", "Event")
    if Event.objects.using(schema_editor.connection.alias).exists():
        raise RuntimeError(
            "Cannot install the active event lifecycle while Event rows exist. "
            "Enable maintenance mode and run purge_scheduling_data before migrating."
        )


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(require_empty_event_table, migrations.RunPython.noop),
        migrations.RemoveConstraint(
            model_name="event",
            name="event_status_is_valid",
        ),
        migrations.AlterField(
            model_name="event",
            name="status",
            field=models.CharField(
                choices=[
                    ("active", "Active"),
                    ("finalized", "Finalized"),
                    ("closed", "Closed"),
                    ("archived", "Archived"),
                ],
                default="active",
                max_length=16,
            ),
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=models.Q(status__in=["active", "finalized", "closed", "archived"]),
                name="event_status_is_valid",
            ),
        ),
    ]
