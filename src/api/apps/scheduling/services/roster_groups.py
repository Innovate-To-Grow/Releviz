"""Participant groups: the group cell grammar and membership writes.

A group cell (an import column, a row input, or a ``group`` payload key)
holds zero or more names separated by ``;``. The reserved token ``ALL``
marks a person as a member of every group, including groups created later.
"""

from collections import defaultdict

from django.db import IntegrityError, transaction
from django.db.models import F, Q, Value
from django.db.models.functions import Lower
from django.utils import timezone

from apps.scheduling.models import Event, Participant, ParticipantGroup

from .roster_imports.errors import RosterImportError

ALL_GROUPS_TOKEN = "ALL"
GROUP_SEPARATOR = ";"
MAX_GROUP_NAME_LENGTH = 100
MAX_GROUPS_PER_CELL = 100
GROUP_TOO_LONG_MESSAGE = f"group is too long (max {MAX_GROUP_NAME_LENGTH})."
TOO_MANY_GROUPS_MESSAGE = f"group may list at most {MAX_GROUPS_PER_CELL} names."


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


def validate_group_names(names) -> list[str]:
    """Validate a list of names, dropping later case variants of the same name."""

    if len(names) > MAX_GROUPS_PER_CELL:
        raise RosterImportError(TOO_MANY_GROUPS_MESSAGE)
    validated = []
    seen = set()
    for name in names:
        normalized = validate_group_name(name)
        key = normalized.lower()
        if key not in seen:
            seen.add(key)
            validated.append(normalized)
    return validated


def parse_group_cell(value) -> tuple[bool, list[str]]:
    """Split a cell into ``(all_groups, names)``.

    Names are deduplicated case-insensitively keeping the first spelling;
    blank tokens are dropped.
    """

    if value is not None and not isinstance(value, str):
        raise RosterImportError("group must be a string.")
    cell = (value or "").strip()
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
    if len(names) > MAX_GROUPS_PER_CELL:
        raise RosterImportError(TOO_MANY_GROUPS_MESSAGE)
    return all_groups, names


def format_group_cell(all_groups: bool, names) -> str:
    tokens = [ALL_GROUPS_TOKEN] if all_groups else []
    tokens.extend(names)
    return f"{GROUP_SEPARATOR} ".join(tokens)


def _lock_event(event: Event) -> Event:
    return Event.objects.select_for_update().get(pk=event.pk)


def _find_group(event: Event, name: str, *, exclude_pk=None):
    # Compare through the database's own LOWER() so the lookup agrees with
    # the one_group_name_per_event constraint on every character.
    query = event.participant_groups.annotate(name_key=Lower("name")).filter(
        name_key=Lower(Value(name))
    )
    if exclude_pk is not None:
        query = query.exclude(pk=exclude_pk)
    return query.first()


def _duplicate_error(name: str) -> RosterImportError:
    return RosterImportError(f"A group named {name} already exists.", status_code=409)


def _create_group(event: Event, name: str) -> tuple[ParticipantGroup, bool]:
    """Insert a group, or return the row that already owns the name.

    The savepoint turns a constraint violation (a case variant the Python
    comparison missed, or a concurrent insert) into a plain lookup.
    """

    try:
        with transaction.atomic():
            return ParticipantGroup.objects.create(event=event, name=name), True
    except IntegrityError:
        existing = _find_group(event, name)
        if existing is None:
            raise
        return existing, False


def _bump_versions(group: ParticipantGroup) -> None:
    """Advance the version of everyone whose ``group`` string the change alters."""

    Participant.objects.filter(event=group.event).filter(
        Q(groups=group) | Q(all_groups=True)
    ).update(version=F("version") + 1, updated_at=timezone.now())


@transaction.atomic
def create_group(*, event: Event, name) -> ParticipantGroup:
    event = _lock_event(event)
    normalized = validate_group_name(name)
    existing = _find_group(event, normalized)
    if existing is not None:
        raise _duplicate_error(existing.name)
    group, created = _create_group(event, normalized)
    if not created:
        raise _duplicate_error(group.name)
    return group


@transaction.atomic
def rename_group(*, group: ParticipantGroup, name) -> ParticipantGroup:
    """Rename in place; a clash with another group is refused, never merged."""

    _lock_event(group.event)
    normalized = validate_group_name(name)
    clash = _find_group(group.event, normalized, exclude_pk=group.pk)
    if clash is not None:
        raise _duplicate_error(clash.name)
    if group.name == normalized:
        return group
    try:
        with transaction.atomic():
            group.name = normalized
            group.save(update_fields=["name", "updated_at"])
    except IntegrityError as exc:
        group.refresh_from_db(fields=["name"])
        clash = _find_group(group.event, normalized, exclude_pk=group.pk)
        raise _duplicate_error(clash.name if clash else normalized) from exc
    _bump_versions(group)
    return group


@transaction.atomic
def delete_group(*, group: ParticipantGroup) -> None:
    """Drop the group and its memberships; the people stay on the roster."""

    _lock_event(group.event)
    _bump_versions(group)
    group.delete()


@transaction.atomic
def ensure_groups(*, event: Event, names) -> list[ParticipantGroup]:
    """Return the event's group for each name, creating the missing ones.

    Lookups are case-insensitive, so a later spelling reuses the existing
    group instead of creating a case variant.
    """

    event = _lock_event(event)
    by_key = {group.name.lower(): group for group in event.participant_groups.all()}
    groups = []
    for name in names:
        normalized = validate_group_name(name)
        key = normalized.lower()
        group = by_key.get(key)
        if group is None:
            group = _find_group(event, normalized) or _create_group(event, normalized)[0]
            by_key[key] = group
            by_key[group.name.lower()] = group
        groups.append(group)
    return groups


def memberships_differ(*, participant: Participant, all_groups: bool, names) -> bool:
    """Whether applying ``(all_groups, names)`` would change the person's groups."""

    if bool(all_groups) != participant.all_groups:
        return True
    current = {group.name.lower() for group in participant.groups.all()}
    return {str(name).strip().lower() for name in names} != current


def _write_memberships(plans) -> set[int]:
    """Apply ``(participant, target_group_ids, all_groups)`` plans; returns changed ids."""

    through = Participant.groups.through
    current = defaultdict(set)
    row_ids = {}
    memberships = through.objects.filter(
        participant_id__in=[participant.pk for participant, _ids, _flag in plans]
    ).values_list("pk", "participant_id", "participantgroup_id")
    for row_id, participant_id, group_id in memberships:
        current[participant_id].add(group_id)
        row_ids[(participant_id, group_id)] = row_id

    changed = set()
    new_rows = []
    dropped_rows = []
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
        dropped_rows.extend(row_ids[(participant.pk, group_id)] for group_id in dropped)
        if flag != participant.all_groups:
            participant.all_groups = flag
            flag_updates[flag].append(participant.pk)
    if dropped_rows:
        through.objects.filter(pk__in=dropped_rows).delete()
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
    resolved = ensure_groups(event=event, names=[*replace_names, *add])
    replace_ids = {group.pk for group in resolved[: len(replace_names)]}
    add_ids = {group.pk for group in resolved[len(replace_names) :]}
    by_key = {group.name.lower(): group for group in event.participant_groups.all()}
    remove_ids = {
        by_key[key].pk
        for key in {str(name if name is not None else "").strip().lower() for name in remove}
        if key in by_key
    }

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
    all_names = [name for _participant, (_flag, names) in assignments for name in names]
    resolved = iter(ensure_groups(event=event, names=all_names))
    plans = [
        (participant, {next(resolved).pk for _name in names}, bool(flag))
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
