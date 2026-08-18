import json
import logging

from django.apps import apps as django_apps
from django.contrib.admin.models import LogEntry
from django.core.management.base import BaseCommand, CommandError
from django.db import DEFAULT_DB_ALIAS, connections, transaction
from django.db.models import Q

from apps.authn.models import ContactEmail, EmailAuthChallenge, Member
from apps.core.models import AWSCredentialConfig, SiteMaintenanceControl
from apps.mail.models import (
    EmailDeliveryJob,
    EmailDeliveryRequest,
    EmailMessageLog,
    EmailProviderConfig,
)
from apps.scheduling.models import Event, EventDeletionRecord, RosterImportReceipt

logger = logging.getLogger(__name__)

CONFIRMATION = "PURGE-SCHEDULING-DATA"
SCHEDULING_MESSAGE_TYPES = (
    EmailMessageLog.MessageType.INVITATION,
    EmailMessageLog.MessageType.REMINDER,
    EmailMessageLog.MessageType.FINAL_CONFIRMATION,
    EmailMessageLog.MessageType.FINAL_CANCELLATION,
)


def _scheduling_models():
    return tuple(django_apps.get_app_config("scheduling").get_models())


def _counts(database):
    temporary_member_ids = Member.objects.using(database).filter(
        access_level=Member.AccessLevel.TEMPORARY
    )
    temporary_member_emails = set(
        ContactEmail.objects.using(database)
        .filter(member_id__in=temporary_member_ids)
        .values_list("email_address", flat=True)
    )
    temporary_member_emails.update(
        temporary_member_ids.exclude(email="").values_list("email", flat=True)
    )
    return {
        "events": Event.objects.using(database).count(),
        "schedulingRows": sum(
            model.objects.using(database).count() for model in _scheduling_models()
        ),
        "temporaryMembers": Member.objects.using(database)
        .filter(access_level=Member.AccessLevel.TEMPORARY)
        .count(),
        "schedulingDeliveryJobs": EmailDeliveryJob.objects.using(database)
        .filter(message_type__in=SCHEDULING_MESSAGE_TYPES)
        .count(),
        "schedulingMessageLogs": EmailMessageLog.objects.using(database)
        .filter(message_type__in=SCHEDULING_MESSAGE_TYPES)
        .count(),
        "temporaryMemberMessageLogs": EmailMessageLog.objects.using(database)
        .filter(recipient__in=temporary_member_emails)
        .count(),
        "temporaryAccessChallenges": EmailAuthChallenge.objects.using(database)
        .filter(purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS)
        .count(),
    }


class Command(BaseCommand):
    help = (
        "Destructively remove Scheduling data for the active-status cutover. "
        "The command is a dry run unless --execute is supplied."
    )

    def add_arguments(self, parser):
        parser.add_argument("--execute", action="store_true")
        parser.add_argument("--confirm", default="")
        parser.add_argument("--expected-event-count", type=int)
        parser.add_argument("--database", default=DEFAULT_DB_ALIAS)

    def handle(self, *args, **options):
        database = options["database"]
        if database not in connections:
            raise CommandError(f"Unknown database alias: {database}")

        before = _counts(database)
        if not options["execute"]:
            self.stdout.write(json.dumps({"dryRun": True, **before}, sort_keys=True))
            return

        if options["confirm"] != CONFIRMATION:
            raise CommandError(f"Execution requires --confirm {CONFIRMATION}")
        expected_event_count = options["expected_event_count"]
        if expected_event_count is None or expected_event_count < 0:
            raise CommandError("Execution requires a non-negative --expected-event-count")

        connection = connections[database]
        with transaction.atomic(using=database):
            maintenance = (
                SiteMaintenanceControl.objects.using(database)
                .select_for_update()
                .filter(pk=1)
                .first()
            )
            if maintenance is None or not maintenance.is_maintenance:
                raise CommandError(
                    "Maintenance mode must be enabled before purging Scheduling data"
                )

            if connection.vendor == "postgresql":
                table_name = connection.ops.quote_name(Event._meta.db_table)
                with connection.cursor() as cursor:
                    # Bind parameters cannot represent table identifiers. This
                    # is trusted model metadata escaped by the active backend.
                    cursor.execute(  # nosemgrep: python.lang.security.audit.formatted-sql-query.formatted-sql-query,python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query
                        f"LOCK TABLE {table_name} IN ACCESS EXCLUSIVE MODE"
                    )

            event_ids = list(
                Event.objects.using(database)
                .select_for_update()
                .order_by("pk")
                .values_list("pk", flat=True)
            )
            if len(event_ids) != expected_event_count:
                raise CommandError(
                    f"Event count changed: expected {expected_event_count}, found {len(event_ids)}"
                )

            full_member_ids = set(
                Member.objects.using(database)
                .exclude(access_level=Member.AccessLevel.TEMPORARY)
                .values_list("pk", flat=True)
            )
            aws_config_ids = set(
                AWSCredentialConfig.objects.using(database).values_list("pk", flat=True)
            )
            email_config_ids = set(
                EmailProviderConfig.objects.using(database).values_list("pk", flat=True)
            )
            temporary_member_ids = list(
                Member.objects.using(database)
                .select_for_update()
                .filter(access_level=Member.AccessLevel.TEMPORARY)
                .order_by("pk")
                .values_list("pk", flat=True)
            )
            temporary_member_emails = set(
                ContactEmail.objects.using(database)
                .filter(member_id__in=temporary_member_ids)
                .values_list("email_address", flat=True)
            )
            temporary_member_emails.update(
                Member.objects.using(database)
                .filter(pk__in=temporary_member_ids)
                .exclude(email="")
                .values_list("email", flat=True)
            )
            if (
                Member.objects.using(database)
                .filter(Q(pk__in=temporary_member_ids) & (Q(is_staff=True) | Q(is_superuser=True)))
                .exists()
            ):
                raise CommandError(
                    "Refusing to purge a temporary member with staff or superuser privileges"
                )
            invitation_ids = list(
                django_apps.get_model("scheduling", "EventInvitation")
                .objects.using(database)
                .filter(event_id__in=event_ids)
                .values_list("pk", flat=True)
            )
            challenge_ids = list(
                EmailAuthChallenge.objects.using(database)
                .select_for_update()
                .filter(
                    Q(purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS)
                    | Q(member_id__in=temporary_member_ids)
                )
                .order_by("pk")
                .values_list("pk", flat=True)
            )
            target_jobs = EmailDeliveryJob.objects.using(database).filter(
                Q(event_id__in=event_ids)
                | Q(message_type__in=SCHEDULING_MESSAGE_TYPES)
                | Q(auth_challenge_id__in=challenge_ids)
                | Q(member_id__in=temporary_member_ids)
            )
            job_ids = list(
                target_jobs.select_for_update().order_by("pk").values_list("pk", flat=True)
            )
            if target_jobs.filter(status=EmailDeliveryJob.Status.PROCESSING).exists():
                raise CommandError(
                    "Refusing to purge while a targeted email delivery job is processing"
                )

            EmailMessageLog.objects.using(database).filter(
                Q(event_id__in=event_ids)
                | Q(invitation_id__in=invitation_ids)
                | Q(delivery_job_id__in=job_ids)
                | Q(message_type__in=SCHEDULING_MESSAGE_TYPES)
                | Q(recipient__in=temporary_member_emails)
            ).delete()
            EmailDeliveryRequest.objects.using(database).filter(event_id__in=event_ids).delete()
            EmailDeliveryJob.objects.using(database).filter(pk__in=job_ids).delete()
            EmailAuthChallenge.objects.using(database).filter(pk__in=challenge_ids).delete()

            # Receipt.batch is PROTECT, so receipts must be removed before Events cascade batches.
            RosterImportReceipt.objects.using(database).all().delete()
            LogEntry.objects.using(database).filter(
                Q(content_type__app_label="scheduling")
                | Q(
                    content_type__app_label="authn",
                    content_type__model="member",
                    object_id__in=[str(member_id) for member_id in temporary_member_ids],
                )
            ).delete()
            EventDeletionRecord.objects.using(database).all().delete()
            Event.objects.using(database).all().delete()
            Member.objects.using(database).filter(pk__in=temporary_member_ids).delete()

            remaining = {
                model._meta.label: model.objects.using(database).count()
                for model in _scheduling_models()
                if model.objects.using(database).exists()
            }
            if remaining:
                raise CommandError(f"Scheduling rows remain after purge: {remaining}")
            if EmailDeliveryRequest.objects.using(database).exists():
                raise CommandError("Scheduling email delivery requests remain after purge")
            if (
                EmailDeliveryJob.objects.using(database)
                .filter(
                    Q(message_type__in=SCHEDULING_MESSAGE_TYPES)
                    | Q(event_id__in=event_ids)
                    | Q(member_id__in=temporary_member_ids)
                )
                .exists()
            ):
                raise CommandError("Targeted email delivery jobs remain after purge")
            if (
                EmailMessageLog.objects.using(database)
                .filter(
                    Q(message_type__in=SCHEDULING_MESSAGE_TYPES)
                    | Q(event_id__in=event_ids)
                    | Q(invitation_id__in=invitation_ids)
                    | Q(delivery_job_id__in=job_ids)
                    | Q(recipient__in=temporary_member_emails)
                )
                .exists()
            ):
                raise CommandError("Scheduling email logs remain after purge")
            if (
                EmailAuthChallenge.objects.using(database)
                .filter(
                    Q(purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS)
                    | Q(member_id__in=temporary_member_ids)
                )
                .exists()
            ):
                raise CommandError("Temporary access challenges remain after purge")
            if (
                Member.objects.using(database)
                .filter(access_level=Member.AccessLevel.TEMPORARY)
                .exists()
            ):
                raise CommandError("Temporary members remain after purge")

            preserved_full_member_ids = set(
                Member.objects.using(database)
                .exclude(access_level=Member.AccessLevel.TEMPORARY)
                .values_list("pk", flat=True)
            )
            preserved_aws_config_ids = set(
                AWSCredentialConfig.objects.using(database).values_list("pk", flat=True)
            )
            preserved_email_config_ids = set(
                EmailProviderConfig.objects.using(database).values_list("pk", flat=True)
            )
            if preserved_full_member_ids != full_member_ids:
                raise CommandError("Full member records changed during Scheduling purge")
            if preserved_aws_config_ids != aws_config_ids:
                raise CommandError("AWS credential configuration changed during Scheduling purge")
            if preserved_email_config_ids != email_config_ids:
                raise CommandError("Email provider configuration changed during Scheduling purge")

        after = _counts(database)
        report = {"dryRun": False, "before": before, "after": after}
        logger.warning("Scheduling data purge completed: %s", report)
        self.stdout.write(self.style.SUCCESS(json.dumps(report, sort_keys=True)))
