import uuid

from django.db import migrations, models


def backfill_invitation_tracking(apps, schema_editor):
    EventInvitation = apps.get_model("scheduling", "EventInvitation")
    for invitation in EventInvitation.objects.all().iterator():
        invitation.access_token = uuid.uuid4()
        update_fields = ["access_token"]
        if invitation.status == "accepted":
            invitation.status = "joined"
            invitation.joined_at = invitation.accepted_at or invitation.updated_at
            update_fields.extend(["status", "joined_at"])
        elif invitation.status == "submitted":
            invitation.joined_at = invitation.accepted_at or invitation.updated_at
            invitation.submitted_at = invitation.updated_at
            update_fields.extend(["joined_at", "submitted_at"])
        invitation.save(update_fields=update_fields)


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0007_event_management_requests"),
    ]

    operations = [
        migrations.AddField(
            model_name="eventinvitation",
            name="access_token",
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.AddField(
            model_name="eventinvitation",
            name="draft_saved_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="eventinvitation",
            name="joined_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="eventinvitation",
            name="opened_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="eventinvitation",
            name="submitted_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(backfill_invitation_tracking, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="eventinvitation",
            name="access_token",
            field=models.UUIDField(default=uuid.uuid4, editable=False, unique=True),
        ),
        migrations.AlterField(
            model_name="eventinvitation",
            name="status",
            field=models.CharField(
                choices=[
                    ("invited", "Invited"),
                    ("opened", "Opened"),
                    ("joined", "Joined"),
                    ("draft_saved", "Draft saved"),
                    ("submitted", "Submitted"),
                ],
                default="invited",
                max_length=16,
            ),
        ),
    ]
