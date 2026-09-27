"""What a recipient would receive, rendered without sending or storing anything.

A preview is the message ``send_email_message`` would build from the same
parts: the same sender, subject header, HTML part (including the branded
fallback for a text-only message), plain-text part, and attachment names.
"""

from collections.abc import Iterable

from apps.mail.models import EmailDeliveryJob

from .services import (
    EmailAttachment,
    _clean_header,
    _delivery_content,
    _deserialize_attachments,
    active_provider_config,
    delivered_html_body,
    sender_addresses,
)


def display_address(email: str, name: str = "") -> str:
    """``Name <email>`` when the person's name is known, else the bare address."""

    name = _clean_header(name)
    return f"{name} <{email}>" if name else email


def email_preview(
    *,
    recipient: str,
    subject: str,
    body: str,
    html_body: str = "",
    attachments: Iterable[EmailAttachment] = (),
    name: str = "",
) -> dict:
    from_email, reply_to = sender_addresses(active_provider_config())
    return {
        "from": from_email,
        "replyTo": reply_to,
        "to": display_address(recipient.strip().lower(), name),
        "subject": _clean_header(subject),
        "html": delivered_html_body(subject=subject, body=body, html_body=html_body),
        "text": body,
        "attachments": [attachment.filename for attachment in attachments],
    }


def job_email_preview(job: EmailDeliveryJob, *, name: str = "") -> dict:
    """The email a queued delivery job sends, as stored."""

    body, html_body = _delivery_content(job)
    return email_preview(
        recipient=job.recipient,
        subject=job.subject,
        body=body,
        html_body=html_body,
        attachments=_deserialize_attachments(job.attachments),
        name=name,
    )
