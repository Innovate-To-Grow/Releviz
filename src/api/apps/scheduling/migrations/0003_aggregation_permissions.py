from django.db import migrations, models


def use_canonical_view_permission(apps, schema_editor):
    Event = apps.get_model("scheduling", "Event")
    Event.objects.filter(participant_view_permission="all").update(
        participant_view_permission="all_after_submit"
    )


def use_legacy_view_permission(apps, schema_editor):
    Event = apps.get_model("scheduling", "Event")
    Event.objects.filter(participant_view_permission="all_after_submit").update(
        participant_view_permission="all"
    )


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0002_event_reminders_and_invitations"),
    ]

    operations = [
        migrations.RunPython(
            use_canonical_view_permission,
            reverse_code=use_legacy_view_permission,
        ),
        migrations.AlterField(
            model_name="event",
            name="participant_view_permission",
            field=models.CharField(
                choices=[
                    ("own_only", "Own only"),
                    ("all_after_submit", "All after submit"),
                    ("realtime", "Realtime"),
                ],
                default="own_only",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="weight",
            name="required",
            field=models.BooleanField(default=False),
        ),
        migrations.AddConstraint(
            model_name="weight",
            constraint=models.CheckConstraint(
                condition=models.Q(("weight__gte", 0.0), ("weight__lte", 1.0)),
                name="weight_between_zero_and_one",
            ),
        ),
    ]
