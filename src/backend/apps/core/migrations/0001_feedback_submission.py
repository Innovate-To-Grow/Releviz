import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="FeedbackSubmission",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "category",
                    models.CharField(
                        choices=[
                            ("problem", "Problem"),
                            ("idea", "Idea"),
                            ("usability", "Usability"),
                            ("other", "Other"),
                        ],
                        max_length=16,
                    ),
                ),
                ("message", models.CharField(max_length=5000)),
                ("page_path", models.CharField(blank=True, default="", max_length=500)),
                ("consent_to_follow_up", models.BooleanField(default=False)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("new", "New"),
                            ("reviewing", "Reviewing"),
                            ("resolved", "Resolved"),
                        ],
                        default="new",
                        max_length=16,
                    ),
                ),
                ("request_id", models.UUIDField(blank=True, null=True)),
                (
                    "member",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="feedback_submissions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["status", "created_at"],
                        name="core_feedba_status_f46ee2_idx",
                    ),
                    models.Index(
                        fields=["category", "created_at"],
                        name="core_feedba_categor_706aef_idx",
                    ),
                    models.Index(
                        fields=["member", "created_at"],
                        name="core_feedba_member__f19642_idx",
                    ),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(
                            ("category__in", ["problem", "idea", "usability", "other"])
                        ),
                        name="feedback_category_is_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("status__in", ["new", "reviewing", "resolved"])),
                        name="feedback_status_is_valid",
                    ),
                ],
            },
        ),
    ]
