from __future__ import annotations

from apps.scheduling.aggregation import (
    participant_has_valid_submission,
    participant_is_excluded,
)


def canonical_view_permission(event) -> str:
    if event.participant_view_permission == "all":
        return "all_after_submit"
    return event.participant_view_permission


def participant_for_user(event, user):
    return event.participants.select_related("event", "member").filter(member_id=user.pk).first()


def weight_for_participant(event, participant):
    return event.weights.filter(participant=participant).first()


def can_view_event_results(event, user) -> bool:
    if event.organizer_id == user.pk:
        return True
    participant = participant_for_user(event, user)
    if participant is None:
        return False
    weight = weight_for_participant(event, participant)
    if participant_is_excluded(participant, weight):
        return False
    permission = canonical_view_permission(event)
    if permission == "realtime":
        return True
    return permission == "all_after_submit" and participant_has_valid_submission(
        participant,
        event,
    )


def visible_participants_for_user(event, user, *, include_hidden: bool = False):
    participants = event.participants.select_related("event", "member").all()
    if event.organizer_id == user.pk:
        return list(participants if include_hidden else participants.filter(hidden=False))

    own_participant = participant_for_user(event, user)
    if own_participant is None:
        return None
    own_weight = weight_for_participant(event, own_participant)
    permission = canonical_view_permission(event)
    can_view_shared = not participant_is_excluded(own_participant, own_weight) and (
        permission == "realtime"
        or (
            permission == "all_after_submit"
            and participant_has_valid_submission(own_participant, event)
        )
    )
    if not can_view_shared:
        return [own_participant]

    weights = {weight.participant_id: weight for weight in event.weights.all()}
    visible = []
    for participant in participants.filter(hidden=False):
        if participant.pk == own_participant.pk:
            visible.append(participant)
            continue
        if participant_is_excluded(participant, weights.get(participant.pk)):
            continue
        if participant_has_valid_submission(participant, event):
            visible.append(participant)
    return visible
