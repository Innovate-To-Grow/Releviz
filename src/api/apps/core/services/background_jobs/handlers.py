
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


def send_notification_email_job(job) -> None:
    from apps.authn.services.email.send_email import send_notification_email
    from apps.core.services.aws.provider_outcomes import ProviderDeliveryError
    from apps.core.services.background_jobs import JobClaimLost

    def begin_provider_call():
        if not job.begin_provider_call():
            raise JobClaimLost("Background job claim was lost before SES invocation.")

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

    try:
        send_ticket_email(
            registration,
            before_token_mutation=fence_token_mutation,
            before_provider_call=begin_provider_call,
            raise_provider_errors=True,
        )
    except ProviderDeliveryError as exc:
        raise _provider_job_error(exc) from exc
