from django.db import migrations, models


def initialize_opened_at(apps, schema_editor):
    Event = apps.get_model("scheduling", "Event")
    for event in Event.objects.filter(opened_at__isnull=True).iterator():
        event.opened_at = event.created_at
        event.save(update_fields=["opened_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0003_aggregation_permissions"),
    ]

    operations = [
        migrations.AddField(
            model_name="event",
            name="archived_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="event",
            name="closed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="event",
            name="finalized_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="event",
            name="opened_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="event",
            name="status",
            field=models.CharField(
                choices=[
                    ("draft", "Draft"),
                    ("open", "Open"),
                    ("finalized", "Finalized"),
                    ("closed", "Closed"),
                    ("archived", "Archived"),
                ],
                default="open",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="event",
            name="version",
            field=models.PositiveBigIntegerField(default=1),
        ),
        migrations.AddField(
            model_name="participant",
            name="version",
            field=models.PositiveBigIntegerField(default=1),
        ),
        migrations.RunPython(initialize_opened_at, reverse_code=migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("status__in", ["draft", "open", "finalized", "closed", "archived"])
                ),
                name="event_status_is_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=models.Q(("version__gte", 1)),
                name="event_version_is_positive",
            ),
        ),
        migrations.AddConstraint(
            model_name="participant",
            constraint=models.CheckConstraint(
                condition=models.Q(("version__gte", 1)),
                name="participant_version_is_positive",
            ),
        ),
    ]
