"""Frontend links carried by invitation emails."""

from apps.mail.services import frontend_url
from apps.scheduling.models import EventInvitation

# What a preview puts where the recipient's private access token would go.
PREVIEW_INVITATION_TOKEN = "preview"


def _invitation_path(invitation: EventInvitation) -> str:
    member = invitation.member
    if member is not None and getattr(member, "access_level", "full") == "temporary":
        return "/temp-access"
    return "/event"


def invitation_link(invitation: EventInvitation) -> str:
    return frontend_url(
        _invitation_path(invitation),
        code=invitation.event.code,
        invitation=str(invitation.access_token),
    )


def preview_invitation_link(invitation: EventInvitation) -> str:
    """The link a preview shows: the recipient's page, without their private token."""

    return frontend_url(
        _invitation_path(invitation),
        code=invitation.event.code,
        invitation=PREVIEW_INVITATION_TOKEN,
    )
