"""Terminal output for outgoing emails.

When ``PRINT_EMAILS_TO_TERMINAL`` is enabled, email transports call
:func:`print_email_to_terminal` instead of delivering the message so that
verification codes, invitations, and reminders stay observable during local
development. Production settings reject this mode.
"""

from __future__ import annotations

import threading

_DIVIDER = "=" * 72
_OUTPUT_LOCK = threading.Lock()


def print_email_to_terminal(
    *,
    subject: str,
    from_email: str,
    recipients: list[str],
    body: str = "",
    html_body: str = "",
    reply_to: str = "",
    message_id: str = "",
    attachment_names: list[str] | None = None,
    message_type: str = "",
) -> None:
    """Print a human-readable copy of an email to stdout."""
    tag = f" [{message_type}]" if message_type else ""
    lines = [
        _DIVIDER,
        f"EMAIL TO TERMINAL{tag} (PRINT_EMAILS_TO_TERMINAL is on - not actually sent)",
        _DIVIDER,
        f"From: {from_email}",
        f"To: {', '.join(recipients)}",
    ]
    if reply_to:
        lines.append(f"Reply-To: {reply_to}")
    lines.append(f"Subject: {subject}")
    if message_id:
        lines.append(f"Message-ID: {message_id}")
    if attachment_names:
        lines.append(f"Attachments: {', '.join(attachment_names)}")
    if body:
        lines.extend((_DIVIDER, body))
    if html_body:
        lines.extend((_DIVIDER, "HTML alternative:", html_body))
    lines.append(_DIVIDER)
    with _OUTPUT_LOCK:
        print("\n".join(lines), flush=True)
