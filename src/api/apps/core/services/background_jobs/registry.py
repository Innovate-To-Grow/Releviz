def _core_handlers():
    from apps.core.services.background_jobs import handlers

    return handlers


def _reject_removed_job(job) -> None:
    """Fail queued work from applications removed from this deployment."""

    from .worker import PermanentJobError

    raise PermanentJobError(
        f"Background job kind {job.kind!r} belongs to a removed application and cannot be processed."
    )


_HANDLER_LOADERS = {
    "authn.notification_email": lambda: _core_handlers().send_notification_email_job,
}

_REMOVED_JOB_KINDS = {
    "cms.amplify_redirects",
    "event.registration_sheet_sync",
    "event.ticket_email",
    "mail.email_recipient",
}

_STATE_HANDLER_LOADERS = {}

_STALE_RESOLVER_LOADERS = {}


def get_handler(kind: str):
    loader = _HANDLER_LOADERS.get(kind)
    if kind in _REMOVED_JOB_KINDS:
        return _reject_removed_job
    if loader is None:
        raise LookupError(f"No background job handler is registered for {kind!r}.")
    return loader()


def notify_job_state(job) -> None:
    """Mirror a generic outbox state into an optional domain-specific record."""

    loader = _STATE_HANDLER_LOADERS.get(job.kind)
    if loader is None:
        return
    loader()(job)


def resolve_stale_job_state(job) -> str | None:
    """Let a handler prove a stale provider job completed before quarantining it."""

    loader = _STALE_RESOLVER_LOADERS.get(job.kind)
    if loader is None:
        return None
    return loader()(job)
