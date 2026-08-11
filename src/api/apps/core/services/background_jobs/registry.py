def _core_handlers():
    from apps.core.services.background_jobs import handlers

    return handlers


def _mail_handlers():
    from apps.mail.services.campaign import dispatch as background_jobs

    return background_jobs


def _cms_handlers():
    from apps.cms.services.amplify import amplify_redirects

    return amplify_redirects


_HANDLER_LOADERS = {
    "authn.notification_email": lambda: _core_handlers().send_notification_email_job,
    "cms.amplify_redirects": lambda: _cms_handlers().sync_amplify_redirects_job,
    "event.registration_sheet_sync": lambda: _core_handlers().sync_registration_sheet_job,
    "event.ticket_email": lambda: _core_handlers().send_ticket_email_job,
    "mail.email_recipient": lambda: _mail_handlers().send_email_recipient_job,
    "mail.sms_recipient": lambda: _mail_handlers().send_sms_recipient_job,
}

_STATE_HANDLER_LOADERS = {
    "cms.amplify_redirects": lambda: _cms_handlers().sync_amplify_redirect_job_state,
    "mail.email_recipient": lambda: _mail_handlers().sync_delivery_job_state,
    "mail.sms_recipient": lambda: _mail_handlers().sync_delivery_job_state,
}

_STALE_RESOLVER_LOADERS = {
    "mail.email_recipient": lambda: _mail_handlers().resolve_stale_delivery_job,
    "mail.sms_recipient": lambda: _mail_handlers().resolve_stale_delivery_job,
}


def get_handler(kind: str):
    loader = _HANDLER_LOADERS.get(kind)
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
