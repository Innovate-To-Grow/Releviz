from django.db import transaction
from django.utils import timezone


def _wait_for_ses_slot() -> None:
    from apps.core.models import EmailServiceConfig

    from .rate_limit import configured_ses_rate, wait_for_delivery_slot

    config = EmailServiceConfig.load()
    wait_for_delivery_slot("ses", configured_ses_rate(config))


def _provider_job_error(exc):
    from apps.core.services.aws.provider_outcomes import (
        PROVIDER_OUTCOME_PERMANENT,
        PROVIDER_OUTCOME_TRANSIENT,
    )

    from .worker import PermanentJobError, TransientJobError, UncertainJobError

    if exc.outcome == PROVIDER_OUTCOME_TRANSIENT:
        return TransientJobError(str(exc))
    if exc.outcome == PROVIDER_OUTCOME_PERMANENT:
        return PermanentJobError(str(exc))
    return UncertainJobError(str(exc))


def sync_member_sheet_job(job) -> None:
    """Run one full member sync and collapse older queued snapshots."""
    from apps.authn.services.members.sheet_sync import _flush_pending_sync
    from apps.authn.services.members.sheet_sync.scheduler import MEMBER_SHEET_JOB_KIND
    from apps.core.models import BackgroundJob

    # Changes committed after this job was claimed create a distinct follow-up
    # job. Only older queued work is redundant with the snapshot about to run.
    with transaction.atomic():
        BackgroundJob.objects.filter(
            kind=MEMBER_SHEET_JOB_KIND,
            status__in=[BackgroundJob.Status.PENDING, BackgroundJob.Status.RETRY],
            created_at__lte=job.claimed_at or timezone.now(),
        ).exclude(pk=job.pk).update(
            status=BackgroundJob.Status.CANCELLED,
            completed_at=timezone.now(),
            last_error="Superseded by a newer full member-sheet snapshot.",
            updated_at=timezone.now(),
        )
    _flush_pending_sync(raise_errors=True)


def send_notification_email_job(job) -> None:
    from apps.authn.services.email.send_email import send_notification_email
    from apps.core.services.aws.provider_outcomes import ProviderDeliveryError
    from apps.core.services.background_jobs import JobClaimLost

    def begin_provider_call():
        if not job.begin_provider_call():
            raise JobClaimLost("Background job claim was lost before SES invocation.")

    _wait_for_ses_slot()
    try:
        sent = send_notification_email(
            **job.payload,
            before_provider_call=begin_provider_call,
            raise_provider_errors=True,
        )
    except ProviderDeliveryError as exc:
        raise _provider_job_error(exc) from exc
    if not sent:
        raise RuntimeError("SES did not confirm notification delivery.")


def sync_registration_sheet_job(job) -> None:
    from apps.event.services.registration_sheet_sync import _flush_pending_sync

    _flush_pending_sync(job.payload["event_id"], raise_errors=True)


def send_ticket_email_job(job) -> None:
    from apps.core.models import BackgroundJob
    from apps.core.services.aws.provider_outcomes import ProviderDeliveryError
    from apps.core.services.background_jobs import JobClaimLost
    from apps.event.models import EventRegistration
    from apps.event.services.ticket.mail import send_ticket_email

    registration = EventRegistration.objects.select_related("event", "ticket", "member").get(
        pk=job.payload["registration_id"]
    )

    def begin_provider_call():
        if not job.begin_provider_call():
            raise JobClaimLost("Background job claim was lost before SES invocation.")

    def fence_token_mutation():
        owns_claim = BackgroundJob.objects.select_for_update().filter(
            pk=job.pk,
            status=BackgroundJob.Status.PROCESSING,
            claim_token=job.claim_token,
        )
        if not owns_claim.exists():
            raise JobClaimLost("Background job claim was lost before login-link issuance.")

    _wait_for_ses_slot()
    try:
        send_ticket_email(
            registration,
            before_token_mutation=fence_token_mutation,
            before_provider_call=begin_provider_call,
            raise_provider_errors=True,
        )
    except ProviderDeliveryError as exc:
        raise _provider_job_error(exc) from exc
