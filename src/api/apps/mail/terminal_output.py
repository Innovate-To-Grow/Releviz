"""Terminal output for outgoing emails.

When ``PRINT_EMAILS_TO_TERMINAL`` is enabled, email transports call
:func:`print_email_to_terminal` instead of delivering the message so that
verification codes, invitations, and reminders stay observable during local
development.
"""

from __future__ import annotations

_DIVIDER = "=" * 72


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
    print(_DIVIDER)
    print(f"EMAIL TO TERMINAL{tag} (PRINT_EMAILS_TO_TERMINAL is on - not actually sent)")
    print(_DIVIDER)
    print(f"From: {from_email}")
    print(f"To: {', '.join(recipients)}")
    if reply_to:
        print(f"Reply-To: {reply_to}")
    print(f"Subject: {subject}")
    if message_id:
        print(f"Message-ID: {message_id}")
    if attachment_names:
        print(f"Attachments: {', '.join(attachment_names)}")
    if body:
        print(_DIVIDER)
        print(body)
    if html_body:
        print(_DIVIDER)
        print("HTML alternative:")
        print(html_body)
    print(_DIVIDER)
