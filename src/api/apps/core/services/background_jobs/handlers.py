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
