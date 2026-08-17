"""Frontend links carried by invitation emails."""

from apps.mail.services import frontend_url
from apps.scheduling.models import EventInvitation


def invitation_link(invitation: EventInvitation) -> str:
    member = invitation.member
    path = (
        "/temp-access"
        if member is not None and getattr(member, "access_level", "full") == "temporary"
        else "/event"
    )
    return frontend_url(
        path,
        code=invitation.event.code,
        invitation=str(invitation.access_token),
    )
