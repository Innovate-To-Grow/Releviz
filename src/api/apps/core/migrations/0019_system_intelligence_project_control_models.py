import uuid

from django.db import migrations, models
from django.utils import timezone


def populate_system_intelligence_config_uuid(apps, schema_editor):
    config_model = apps.get_model("core", "SystemIntelligenceConfig")
    for config in config_model.objects.filter(uuid_id__isnull=True).iterator():
        config.uuid_id = uuid.uuid4()
        config.save(update_fields=["uuid_id"])


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0018_systemintelligenceexport"),
    ]

    operations = [
        migrations.AddField(
            model_name="chatmessage",
            name="updated_at",
            field=models.DateTimeField(auto_now=True, db_index=True, default=timezone.now),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name="systemintelligenceconfig",
            name="created_at",
            field=models.DateTimeField(auto_now_add=True, db_index=True, default=timezone.now),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name="systemintelligenceexport",
            name="updated_at",
            field=models.DateTimeField(auto_now=True, db_index=True, default=timezone.now),
            preserve_default=False,
        ),
        migrations.AlterField(
            model_name="chatconversation",
            name="created_at",
            field=models.DateTimeField(auto_now_add=True, db_index=True),
        ),
        migrations.AlterField(
            model_name="chatconversation",
            name="updated_at",
            field=models.DateTimeField(auto_now=True, db_index=True),
        ),
        migrations.AlterField(
            model_name="chatmessage",
            name="created_at",
            field=models.DateTimeField(auto_now_add=True, db_index=True),
        ),
        migrations.AlterField(
            model_name="systemintelligenceactionrequest",
            name="created_at",
            field=models.DateTimeField(auto_now_add=True, db_index=True),
        ),
        migrations.AlterField(
            model_name="systemintelligenceactionrequest",
            name="updated_at",
            field=models.DateTimeField(auto_now=True, db_index=True),
        ),
        migrations.AlterField(
            model_name="systemintelligenceexport",
            name="created_at",
            field=models.DateTimeField(auto_now_add=True, db_index=True),
        ),
        migrations.AlterField(
            model_name="systemintelligenceconfig",
            name="updated_at",
            field=models.DateTimeField(auto_now=True, db_index=True),
        ),
        migrations.AddField(
            model_name="systemintelligenceconfig",
            name="uuid_id",
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.RunPython(populate_system_intelligence_config_uuid, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name="systemintelligenceconfig",
            name="id",
        ),
        migrations.RenameField(
            model_name="systemintelligenceconfig",
            old_name="uuid_id",
            new_name="id",
        ),
        migrations.AlterField(
            model_name="systemintelligenceconfig",
            name="id",
            field=models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False),
        ),
    ]
