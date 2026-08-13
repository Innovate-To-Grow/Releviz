import logging

from django.template.loader import render_to_string
from django.utils import timezone
from django.utils.formats import date_format

from apps.mail.email_templates import render_branded_email

from .actions import render_email_body
from .config import PURPOSE_SUBJECTS

logger = logging.getLogger(__name__)
SES_DELIVERY_ERROR = "Email delivery via AWS SES failed or is not configured."


def send_notification_email(
    *,
    recipient: str,
    subject: str,
    template: str,
    context: dict,
    before_provider_call=None,
    raise_provider_errors: bool = False,
) -> bool:
    import apps.authn.services.email.send_email as email_api

    html_body = render_to_string(template, context)

    send_kwargs = {
        "recipient": recipient,
        "subject": subject,
        "html_body": html_body,
    }
    if before_provider_call is not None:
        send_kwargs["before_provider_call"] = before_provider_call
    if raise_provider_errors:
        send_kwargs["raise_provider_errors"] = True

    if email_api._send_via_ses(
        **send_kwargs,
    ):
        logger.info("Notification email sent via SES")
        return True

    logger.error("Notification email was not sent: %s", SES_DELIVERY_ERROR)
    return False


def send_admin_invitation_email(*, invitation, request=None):
    import apps.authn.services.email.send_email as email_api

    subject = "You're invited to join Releviz Admin"
    invited_by = invitation.invited_by
    inviter_name = "The Releviz team"
    if invited_by is not None:
        inviter_name = invited_by.get_full_name() or str(invited_by)
    role = invitation.get_role_display()
    expires_at = date_format(timezone.localtime(invitation.expires_at), "F j, Y, P T")
    html_body = render_branded_email(
        title="You're invited to join Releviz Admin",
        preheader=f"{inviter_name} invited you to join Releviz Admin.",
        eyebrow="Releviz Admin",
        paragraphs=(f"{inviter_name} invited you to join the Releviz admin team.",),
        details=(("Role", role), ("Invitation expires", expires_at)),
        cta_label="Accept invitation",
        cta_url=invitation.get_acceptance_url(request),
        notice=invitation.message
        or "If you were not expecting this invitation, you can safely ignore this email.",
    )

    if email_api._send_via_ses(
        recipient=invitation.email,
        subject=subject,
        html_body=html_body,
    ):
        logger.info("Admin invitation email sent via SES")
        return

    raise RuntimeError(SES_DELIVERY_ERROR)


def send_verification_email(
    *,
    recipient: str,
    code: str,
    purpose: str,
    link_flow: str | None = None,
    link_source: str | None = None,
    link_event: str | None = None,
    link_next: str | None = None,
):
    import apps.authn.services.email.send_email as email_api

    subject = PURPOSE_SUBJECTS.get(
        purpose,
        "Your verification code - Releviz",
    )
    html_body = render_email_body(
        recipient=recipient,
        code=code,
        purpose=purpose,
        link_flow=link_flow,
        link_source=link_source,
        link_event=link_event,
        link_next=link_next,
    )

    if email_api._send_via_ses(
        recipient=recipient,
        subject=subject,
        html_body=html_body,
    ):
        logger.info("Verification email sent via SES")
        return

    raise RuntimeError(SES_DELIVERY_ERROR)
