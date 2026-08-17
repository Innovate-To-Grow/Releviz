"""Patch-compatible email sending namespace.

The concrete implementation is split across sibling modules, but tests and
some callers patch this package directly (for example
``authn.services.email.send_email.boto3``). Keep those hub attributes imported
here even when they are not part of the public star-import surface.
"""

import boto3 as boto3

from . import actions, transport
from .senders import (
    send_admin_invitation_email,
    send_notification_email,
    send_verification_email,
)

_render_email_body = actions.render_email_body
_send_via_django_backend = transport._send_via_django_backend
_send_via_ses = transport._send_via_ses

__all__ = [
    "send_admin_invitation_email",
    "send_notification_email",
    "send_verification_email",
]
