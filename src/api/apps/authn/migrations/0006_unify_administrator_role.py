from django.db import migrations, models


def unify_administrators(apps, schema_editor):
    Member = apps.get_model("authn", "Member")
    Member.objects.using(schema_editor.connection.alias).filter(
        models.Q(is_staff=True) | models.Q(is_superuser=True)
    ).update(is_staff=True, is_superuser=True)


class Migration(migrations.Migration):
    dependencies = [("authn", "0005_contactemail_case_insensitive_unique")]

    operations = [
        migrations.RunPython(unify_administrators, reverse_code=migrations.RunPython.noop),
        migrations.AlterField(
            model_name="member",
            name="is_staff",
            field=models.BooleanField(
                default=False,
                help_text="Allows full access to all administration modules and administrator management.",
                verbose_name="Administrator",
            ),
        ),
        migrations.AlterField(
            model_name="member",
            name="is_superuser",
            field=models.BooleanField(default=False, editable=False),
        ),
        migrations.AlterField(
            model_name="member",
            name="admin_apps",
            field=models.JSONField(
                blank=True,
                default=list,
                editable=False,
                help_text="Legacy app grants; administrators now have access to every app.",
                verbose_name="Legacy admin apps",
            ),
        ),
    ]
