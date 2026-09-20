import django.db.models.deletion
import django.db.models.functions.text
from django.db import migrations, models


def copy_group_names_to_memberships(apps, schema_editor):
    Participant = apps.get_model("scheduling", "Participant")
    ParticipantGroup = apps.get_model("scheduling", "ParticipantGroup")
    alias = schema_editor.connection.alias
    # Keyed by (event_id, lower-cased name): the first spelling seen names the
    # group, so case variants on one event collapse into a single row and the
    # case-insensitive unique constraint never fails.
    groups = {}
    participants = (
        Participant.objects.using(alias)
        .exclude(group_name__isnull=True)
        .exclude(group_name="")
        .order_by("pk")
    )
    for participant in participants:
        name = participant.group_name.strip()
        if not name:
            continue
        key = (participant.event_id, name.lower())
        group = groups.get(key)
        if group is None:
            group = ParticipantGroup.objects.using(alias).create(
                event_id=participant.event_id,
                name=name,
            )
            groups[key] = group
        participant.groups.add(group)


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0003_alter_rosterimportreceipt_batch"),
    ]

    operations = [
        migrations.CreateModel(
            name="ParticipantGroup",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("name", models.CharField(max_length=100)),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="participant_groups",
                        to="scheduling.event",
                    ),
                ),
            ],
            options={
                "ordering": [django.db.models.functions.text.Lower("name"), "pk"],
            },
        ),
        migrations.AddConstraint(
            model_name="participantgroup",
            constraint=models.UniqueConstraint(
                models.F("event"),
                django.db.models.functions.text.Lower("name"),
                name="one_group_name_per_event",
            ),
        ),
        migrations.AddField(
            model_name="participant",
            name="all_groups",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="participant",
            name="groups",
            field=models.ManyToManyField(
                blank=True,
                related_name="participants",
                to="scheduling.participantgroup",
            ),
        ),
        migrations.AlterField(
            model_name="rosterimportrow",
            name="group_name",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.RunPython(copy_group_names_to_memberships, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name="participant",
            name="group_name",
        ),
    ]
