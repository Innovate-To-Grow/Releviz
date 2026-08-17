"""Stable fingerprints for idempotent requests and email content."""

import hashlib
import json

from apps.mail.services import EmailAttachment


def payload_fingerprint(payload: dict) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def email_content_fingerprint(
    *,
    subject: str,
    body: str,
    html_body: str,
    attachments: list[EmailAttachment],
) -> str:
    return payload_fingerprint(
        {
            "subject": subject,
            "body": body,
            "htmlBody": html_body,
            "attachments": [
                {
                    "filename": attachment.filename,
                    "content": attachment.content,
                    "mimetype": attachment.mimetype,
                }
                for attachment in attachments
            ],
        }
    )
