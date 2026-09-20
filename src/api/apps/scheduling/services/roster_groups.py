"""Participant groups: the group cell grammar and membership writes.

A group cell (an import column, a row input, or a ``group`` payload key)
holds zero or more names separated by ``;``. The reserved token ``ALL``
marks a person as a member of every group, including groups created later.
"""

from collections import defaultdict

from django.db import transaction
from django.utils import timezone

from apps.scheduling.models import Event, Participant, ParticipantGroup

from .roster_imports.errors import RosterImportError

ALL_GROUPS_TOKEN = "ALL"
GROUP_SEPARATOR = ";"
MAX_GROUP_NAME_LENGTH = 100
GROUP_TOO_LONG_MESSAGE = f"group is too long (max {MAX_GROUP_NAME_LENGTH})."


def validate_group_name(name) -> str:
    """Return the stripped name or raise a ``RosterImportError``."""

    normalized = str(name if name is not None else "").strip()
    if not normalized:
        raise RosterImportError("Group name is required.")
    if normalized.upper() == ALL_GROUPS_TOKEN:
        raise RosterImportError(f"{ALL_GROUPS_TOKEN} is reserved for every group.")
    if GROUP_SEPARATOR in normalized:
        raise RosterImportError(f"Group names cannot contain {GROUP_SEPARATOR}.")
    if len(normalized) > MAX_GROUP_NAME_LENGTH:
        raise RosterImportError(GROUP_TOO_LONG_MESSAGE)
    return normalized


def parse_group_cell(value) -> tuple[bool, list[str]]:
    """Split a cell into ``(all_groups, names)``.

    Names are deduplicated case-insensitively keeping the first spelling;
    blank tokens are dropped.
    """

    cell = str(value if value is not None else "").strip()
    if not cell:
        return False, []
    all_groups = False
    names = []
    seen = set()
    for token in cell.split(GROUP_SEPARATOR):
        name = token.strip()
        if not name:
            continue
        if name.upper() == ALL_GROUPS_TOKEN:
            all_groups = True
            continue
        if len(name) > MAX_GROUP_NAME_LENGTH:
            raise RosterImportError(GROUP_TOO_LONG_MESSAGE)
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
    return all_groups, names


def format_group_cell(all_groups: bool, names) -> str:
    tokens = [ALL_GROUPS_TOKEN] if all_groups else []
    tokens.extend(names)
    return f"{GROUP_SEPARATOR} ".join(tokens)


def _lock_event(event: Event) -> Event:
    return Event.objects.select_for_update().get(pk=event.pk)


def _groups_by_key(event: Event) -> dict[str, ParticipantGroup]:
    return {group.name.lower(): group for group in event.participant_groups.all()}


def _duplicate_error(name: str) -> RosterImportError:
    return RosterImportError(f"A group named {name} already exists.", status_code=409)


@transaction.atomic
def create_group(*, event: Event, name) -> ParticipantGroup:
    event = _lock_event(event)
    normalized = validate_group_name(name)
    existing = event.participant_groups.filter(name__iexact=normalized).first()
    if existing is not None:
        raise _duplicate_error(existing.name)
    return ParticipantGroup.objects.create(event=event, name=normalized)


@transaction.atomic
def rename_group(*, group: ParticipantGroup, name) -> ParticipantGroup:
    """Rename in place; a clash with another group is refused, never merged."""

    _lock_event(group.event)
    normalized = validate_group_name(name)
    clash = (
        group.event.participant_groups.filter(name__iexact=normalized).exclude(pk=group.pk).first()
    )
    if clash is not None:
        raise _duplicate_error(clash.name)
    if group.name != normalized:
        group.name = normalized
        group.save(update_fields=["name", "updated_at"])
    return group


@transaction.atomic
def delete_group(*, group: ParticipantGroup) -> None:
    """Drop the group and its memberships; the people stay on the roster."""

    _lock_event(group.event)
    group.delete()


@transaction.atomic
def ensure_groups(*, event: Event, names) -> list[ParticipantGroup]:
    """Return the event's group for each name, creating the missing ones.

    Lookups are case-insensitive, so a later spelling reuses the existing
    group instead of creating a case variant.
    """

    event = _lock_event(event)
    by_key = _groups_by_key(event)
    groups = []
    for name in names:
        normalized = validate_group_name(name)
        key = normalized.lower()
        group = by_key.get(key)
        if group is None:
            group = ParticipantGroup.objects.create(event=event, name=normalized)
            by_key[key] = group
        groups.append(group)
    return groups


def _write_memberships(plans) -> set[int]:
    """Apply ``(participant, target_group_ids, all_groups)`` plans; returns changed ids."""

    through = Participant.groups.through
    current = defaultdict(set)
    memberships = through.objects.filter(
        participant_id__in=[participant.pk for participant, _ids, _flag in plans]
    ).values_list("participant_id", "participantgroup_id")
    for participant_id, group_id in memberships:
        current[participant_id].add(group_id)

    changed = set()
    new_rows = []
    flag_updates = {True: [], False: []}
    for participant, target, flag in plans:
        added = target - current[participant.pk]
        dropped = current[participant.pk] - target
        if added or dropped or flag != participant.all_groups:
            changed.add(participant.pk)
        new_rows.extend(
            through(participant_id=participant.pk, participantgroup_id=group_id)
            for group_id in added
        )
        if dropped:
            through.objects.filter(
                participant_id=participant.pk, participantgroup_id__in=dropped
            ).delete()
        if flag != participant.all_groups:
            participant.all_groups = flag
            flag_updates[flag].append(participant.pk)
    if new_rows:
        through.objects.bulk_create(new_rows)
    now = timezone.now()
    for flag, participant_ids in flag_updates.items():
        if participant_ids:
            Participant.objects.filter(pk__in=participant_ids).update(
                all_groups=flag, updated_at=now
            )
    return changed


@transaction.atomic
def update_memberships(
    *,
    event: Event,
    participants,
    replace: tuple[bool, list] | None = None,
    add=(),
    remove=(),
    all_groups: bool | None = None,
) -> set[int]:
    """Edit several people's memberships at once; returns the changed participant ids.

    ``replace`` is a parsed cell ``(all_groups, names)`` that overwrites both
    the memberships and the flag (a blank cell clears both). ``add`` names are
    created when missing, ``remove`` names that do not exist are ignored, and
    an explicit ``all_groups`` wins over the flag in ``replace``. Every
    participant instance is updated in memory; ``all_groups`` is persisted here.
    """

    participants = list(participants)
    if not participants:
        return set()
    event = _lock_event(event)
    replace_names = list(replace[1]) if replace is not None else []
    by_key = {
        group.name.lower(): group
        for group in ensure_groups(event=event, names=[*replace_names, *add])
    }
    by_key.update(_groups_by_key(event))
    remove_ids = {
        by_key[key].pk
        for key in {str(name if name is not None else "").strip().lower() for name in remove}
        if key in by_key
    }
    add_ids = {by_key[validate_group_name(name).lower()].pk for name in add}
    replace_ids = {by_key[name.lower()].pk for name in replace_names}

    plans = []
    current = defaultdict(set)
    for participant_id, group_id in Participant.groups.through.objects.filter(
        participant_id__in=[participant.pk for participant in participants]
    ).values_list("participant_id", "participantgroup_id"):
        current[participant_id].add(group_id)
    for participant in participants:
        target = set(current[participant.pk])
        flag = participant.all_groups
        if replace is not None:
            flag = bool(replace[0])
            target = set(replace_ids)
        target |= add_ids
        target -= remove_ids
        if all_groups is not None:
            flag = bool(all_groups)
        plans.append((participant, target, flag))
    return _write_memberships(plans)


@transaction.atomic
def assign_memberships(*, event: Event, assignments) -> set[int]:
    """Replace each person's memberships from ``(participant, (all_groups, names))`` pairs.

    Used by the roster import, where every row carries its own cell. Missing
    groups are created once for the whole batch; returns the changed ids.
    """

    assignments = list(assignments)
    if not assignments:
        return set()
    event = _lock_event(event)
    by_key = {
        group.name.lower(): group
        for group in ensure_groups(
            event=event,
            names=[name for _participant, (_flag, names) in assignments for name in names],
        )
    }
    plans = [
        (participant, {by_key[name.lower()].pk for name in names}, bool(flag))
        for participant, (flag, names) in assignments
    ]
    return _write_memberships(plans)


def set_participant_groups(*, participant: Participant, all_groups: bool, names) -> bool:
    """Replace the memberships and the ``all_groups`` flag; True when anything changed."""

    return bool(
        update_memberships(
            event=participant.event,
            participants=[participant],
            replace=(all_groups, list(names)),
        )
    )


def add_participant_groups(*, participant: Participant, names) -> bool:
    return bool(
        update_memberships(event=participant.event, participants=[participant], add=list(names))
    )


def remove_participant_groups(*, participant: Participant, names) -> bool:
    """Drop the named memberships; unknown names are ignored."""

    return bool(
        update_memberships(event=participant.event, participants=[participant], remove=list(names))
    )
