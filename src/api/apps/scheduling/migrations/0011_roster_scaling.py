import uuid

import django.db.models.deletion
import django.db.models.functions.math
import django.db.models.lookups
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0010_temporary_event_session"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="EventResultSnapshot",
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
                ("requested_revision", models.PositiveBigIntegerField(default=1)),
                ("computed_revision", models.PositiveBigIntegerField(default=0)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("refreshing", "Refreshing"),
                            ("fresh", "Fresh"),
                            ("failed", "Failed"),
                        ],
                        default="refreshing",
                        max_length=16,
                    ),
                ),
                ("payload", models.JSONField(default=dict)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                ("last_error", models.TextField(blank=True, default="")),
                ("locked_at", models.DateTimeField(blank=True, null=True)),
                ("lock_token", models.UUIDField(blank=True, null=True)),
            ],
        ),
        migrations.CreateModel(
            name="RosterImportBatch",
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
                    "source_type",
                    models.CharField(
                        choices=[
                            ("csv", "CSV upload"),
                            ("xlsx", "Excel upload"),
                            ("paste", "Pasted table"),
                        ],
                        max_length=16,
                    ),
                ),
                ("source_label", models.CharField(blank=True, default="", max_length=64)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("preview", "Preview"),
                            ("committing", "Committing"),
                            ("committed", "Committed"),
                            ("canceled", "Canceled"),
                            ("expired", "Expired"),
                            ("failed", "Failed"),
                        ],
                        default="preview",
                        max_length=16,
                    ),
                ),
                ("worksheets", models.JSONField(default=list)),
                ("selected_worksheet", models.CharField(blank=True, default="", max_length=128)),
                ("header_row", models.PositiveIntegerField(default=1)),
                ("column_mapping", models.JSONField(default=dict)),
                ("defaults", models.JSONField(default=dict)),
                ("summary", models.JSONField(default=dict)),
                ("expires_at", models.DateTimeField()),
                ("failure_reason", models.CharField(blank=True, default="", max_length=500)),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="RosterImportReceipt",
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
                ("idempotency_key", models.UUIDField()),
                ("request_fingerprint", models.CharField(max_length=64)),
                (
                    "mode",
                    models.CharField(
                        choices=[("merge", "Merge"), ("rebuild", "Rebuild")],
                        max_length=16,
                    ),
                ),
                ("imported_count", models.PositiveIntegerField(default=0)),
                ("created_count", models.PositiveIntegerField(default=0)),
                ("updated_count", models.PositiveIntegerField(default=0)),
                ("results_revision", models.PositiveBigIntegerField()),
                ("committed_at", models.DateTimeField(default=django.utils.timezone.now)),
            ],
            options={"ordering": ["-committed_at"]},
        ),
        migrations.CreateModel(
            name="RosterImportRow",
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
                ("worksheet", models.CharField(max_length=128)),
                ("row_number", models.PositiveIntegerField()),
                ("raw_values", models.JSONField(default=list)),
                ("name", models.CharField(blank=True, default="", max_length=100)),
                ("email", models.EmailField(blank=True, default="", max_length=254)),
                ("group_name", models.CharField(blank=True, default="", max_length=100)),
                ("weight", models.FloatField(default=1.0)),
                ("included", models.BooleanField(default=True)),
                ("selected", models.BooleanField(default=False)),
                ("validation_errors", models.JSONField(default=list)),
                (
                    "duplicate_status",
                    models.CharField(
                        choices=[
                            ("unique", "Unique"),
                            ("identical", "Identical duplicate"),
                            ("conflict", "Conflicting duplicate"),
                        ],
                        default="unique",
                        max_length=16,
                    ),
                ),
            ],
            options={"ordering": ["worksheet", "row_number"]},
        ),
        migrations.CreateModel(
            name="ScheduleEditRecord",
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
                    "source",
                    models.CharField(
                        choices=[
                            ("self", "Participant"),
                            ("organizer", "Organizer"),
                            ("import", "Import"),
                            ("system", "System"),
                        ],
                        max_length=16,
                    ),
                ),
                (
                    "action",
                    models.CharField(
                        choices=[
                            ("draft", "Draft"),
                            ("submit", "Submit"),
                            ("withdraw", "Withdraw"),
                        ],
                        max_length=16,
                    ),
                ),
                ("participant_version", models.PositiveBigIntegerField()),
                ("actor_identifier", models.UUIDField(blank=True, null=True)),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.RemoveField(model_name="weight", name="required"),
        migrations.AddField(
            model_name="event",
            name="access_mode",
            field=models.CharField(
                choices=[("invite_only", "Invite only"), ("open_link", "Open link")],
                default="invite_only",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="event",
            name="meeting_duration_minutes",
            field=models.PositiveSmallIntegerField(default=30),
        ),
        migrations.AddField(
            model_name="event",
            name="results_revision",
            field=models.PositiveBigIntegerField(default=1),
        ),
        migrations.AlterField(
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
                default="draft",
                max_length=16,
            ),
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=models.Q(access_mode__in=["invite_only", "open_link"]),
                name="event_access_mode_is_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    meeting_duration_minutes__gte=15,
                    meeting_duration_minutes__lte=480,
                ),
                name="event_meeting_duration_in_range",
            ),
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=django.db.models.lookups.Exact(
                    django.db.models.functions.math.Mod(
                        models.F("meeting_duration_minutes"),
                        models.F("slot_minutes"),
                    ),
                    0,
                ),
                name="event_meeting_duration_aligns_to_slot",
            ),
        ),
        migrations.AddConstraint(
            model_name="event",
            constraint=models.CheckConstraint(
                condition=models.Q(results_revision__gte=1),
                name="event_results_revision_is_positive",
            ),
        ),
        migrations.AddField(
            model_name="eventresultsnapshot",
            name="event",
            field=models.OneToOneField(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="result_snapshot",
                to="scheduling.event",
            ),
        ),
        migrations.AddField(
            model_name="rosterimportbatch",
            name="created_by",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="roster_import_batches",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="rosterimportbatch",
            name="event",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="roster_import_batches",
                to="scheduling.event",
            ),
        ),
        migrations.AddField(
            model_name="rosterimportreceipt",
            name="batch",
            field=models.OneToOneField(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="receipt",
                to="scheduling.rosterimportbatch",
            ),
        ),
        migrations.AddField(
            model_name="rosterimportreceipt",
            name="committed_by",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="roster_import_receipts",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="rosterimportreceipt",
            name="event",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="roster_import_receipts",
                to="scheduling.event",
            ),
        ),
        migrations.AddField(
            model_name="rosterimportrow",
            name="batch",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="rows",
                to="scheduling.rosterimportbatch",
            ),
        ),
        migrations.AddField(
            model_name="scheduleeditrecord",
            name="actor",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="schedule_edit_records",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="scheduleeditrecord",
            name="event",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="schedule_edit_records",
                to="scheduling.event",
            ),
        ),
        migrations.AddField(
            model_name="scheduleeditrecord",
            name="participant",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="schedule_edit_records",
                to="scheduling.participant",
            ),
        ),
        migrations.AddIndex(
            model_name="eventresultsnapshot",
            index=models.Index(
                fields=["status", "updated_at"],
                name="scheduling__status_0d72ca_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="eventresultsnapshot",
            index=models.Index(fields=["locked_at"], name="scheduling__locked__621935_idx"),
        ),
        migrations.AddConstraint(
            model_name="eventresultsnapshot",
            constraint=models.CheckConstraint(
                condition=models.Q(requested_revision__gte=0),
                name="result_snapshot_requested_revision_nonnegative",
            ),
        ),
        migrations.AddConstraint(
            model_name="eventresultsnapshot",
            constraint=models.CheckConstraint(
                condition=models.Q(computed_revision__gte=0),
                name="result_snapshot_computed_revision_nonnegative",
            ),
        ),
        migrations.AddIndex(
            model_name="rosterimportbatch",
            index=models.Index(
                fields=["event", "status", "created_at"],
                name="scheduling__event_i_2e05f2_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="rosterimportbatch",
            index=models.Index(
                fields=["status", "expires_at"],
                name="scheduling__status_b3896c_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="rosterimportreceipt",
            constraint=models.UniqueConstraint(
                fields=("event", "idempotency_key"),
                name="one_roster_import_receipt_per_key",
            ),
        ),
        migrations.AddConstraint(
            model_name="rosterimportreceipt",
            constraint=models.CheckConstraint(
                condition=models.Q(results_revision__gte=1),
                name="roster_receipt_results_revision_positive",
            ),
        ),
        migrations.AddIndex(
            model_name="rosterimportrow",
            index=models.Index(
                fields=["batch", "worksheet", "row_number"],
                name="scheduling__batch_i_ae075a_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="rosterimportrow",
            index=models.Index(
                fields=["batch", "selected", "duplicate_status"],
                name="scheduling__batch_i_a47c58_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="rosterimportrow",
            constraint=models.UniqueConstraint(
                fields=("batch", "worksheet", "row_number"),
                name="one_roster_import_row_position",
            ),
        ),
        migrations.AddConstraint(
            model_name="rosterimportrow",
            constraint=models.CheckConstraint(
                condition=models.Q(weight__gte=0.0, weight__lte=1.0),
                name="roster_import_weight_in_range",
            ),
        ),
        migrations.AddIndex(
            model_name="scheduleeditrecord",
            index=models.Index(
                fields=["event", "created_at"],
                name="scheduling__event_i_f61be9_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="scheduleeditrecord",
            index=models.Index(
                fields=["participant", "created_at"],
                name="scheduling__partici_2a0f9b_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="scheduleeditrecord",
            constraint=models.CheckConstraint(
                condition=models.Q(participant_version__gte=1),
                name="schedule_edit_participant_version_positive",
            ),
        ),
    ]
