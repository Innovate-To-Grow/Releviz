from django.db import migrations, models


def backfill_analytics_timestamps(apps, schema_editor):
    EventInvitation = apps.get_model("scheduling", "EventInvitation")
    Participant = apps.get_model("scheduling", "Participant")
    EventInvitation.objects.filter(
        first_sent_at__isnull=True,
        last_sent_at__isnull=False,
    ).update(first_sent_at=models.F("last_sent_at"))
    Participant.objects.filter(submitted=True, first_submitted_at__isnull=True).update(
        first_submitted_at=models.F("updated_at"),
        last_submitted_at=models.F("updated_at"),
    )


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0008_invitation_engagement_tracking"),
    ]

    operations = [
        migrations.AddField(
            model_name="eventinvitation",
            name="first_sent_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="participant",
            name="first_draft_saved_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="participant",
            name="first_submitted_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="participant",
            name="last_submitted_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(backfill_analytics_timestamps, migrations.RunPython.noop),
        migrations.AddIndex(
            model_name="eventinvitation",
            index=models.Index(
                fields=["first_sent_at"],
                name="scheduling__first_s_90998e_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="participant",
            index=models.Index(
                fields=["event", "submitted"],
                name="scheduling__event_i_a24ab8_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="participant",
            index=models.Index(
                fields=["first_submitted_at"],
                name="scheduling__first_s_690e52_idx",
            ),
        ),
    ]
