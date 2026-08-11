from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("mail", "0004_auth_email_delivery"),
    ]

    operations = [
        migrations.AlterField(
            model_name="emaildeliveryrequest",
            name="operation",
            field=models.CharField(
                choices=[
                    ("invitation", "Invitation"),
                    ("reminder", "Reminder"),
                    ("final_confirmation", "Final confirmation"),
                    ("final_cancellation", "Final cancellation"),
                ],
                max_length=24,
            ),
        ),
    ]
