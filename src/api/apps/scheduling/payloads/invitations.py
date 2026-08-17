"""API payloads for event invitations."""

from apps.scheduling.models import EventInvitation


def api_invitation(invitation: EventInvitation) -> dict:
    status_label = dict(EventInvitation.Status.choices).get(
        invitation.status,
        invitation.status.replace("_", " ").title(),
    )
    return {
        "id": invitation.pk,
        "email": invitation.email,
        "memberId": str(invitation.member_id) if invitation.member_id else None,
        "status": invitation.status,
        "statusLabel": status_label,
        "firstSentAt": (invitation.first_sent_at.isoformat() if invitation.first_sent_at else None),
        "lastSentAt": invitation.last_sent_at.isoformat() if invitation.last_sent_at else None,
        "reminderSentAt": invitation.reminder_sent_at.isoformat()
        if invitation.reminder_sent_at
        else None,
        "acceptedAt": invitation.accepted_at.isoformat() if invitation.accepted_at else None,
        "openedAt": invitation.opened_at.isoformat() if invitation.opened_at else None,
        "joinedAt": invitation.joined_at.isoformat() if invitation.joined_at else None,
        "draftSavedAt": (
            invitation.draft_saved_at.isoformat() if invitation.draft_saved_at else None
        ),
        "submittedAt": invitation.submitted_at.isoformat() if invitation.submitted_at else None,
        "awaitingReminder": bool(
            invitation.event.reminders_enabled
            and invitation.status != EventInvitation.Status.SUBMITTED
            and invitation.last_sent_at
            and not invitation.reminder_sent_at
        ),
        "customMessage": invitation.custom_message,
    }
