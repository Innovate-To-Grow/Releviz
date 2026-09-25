import re
from collections import defaultdict

from django.db import migrations

# 0007 rewrote the legacy ";" separator inside a name to "," so the name
# stayed one token; now that "," separates names too, no name may keep one.
_WHITESPACE = re.compile(r"\s+")
_NAME_MAX_LENGTH = 100
# The reserved cell token can never name a group; renaming must not produce it.
_RESERVED = "all"
_FALLBACK_NAME = "Group"


def comma_free_group_name(value) -> str:
    """The name with every ``,`` turned into a space and the whitespace tidied."""

    return _WHITESPACE.sub(" ", str(value or "").replace(",", " ")).strip()


def drop_commas_from_group_names(apps, schema_editor):
    ParticipantGroup = apps.get_model("scheduling", "ParticipantGroup")
    alias = schema_editor.connection.alias
    by_event = defaultdict(list)
    for group in (
        ParticipantGroup.objects.using(alias).filter(name__contains=",").order_by("event_id", "pk")
    ):
        by_event[group.event_id].append(group)
    for event_id, groups in by_event.items():
        # Names are unique per event ignoring case; the groups that keep their
        # name are claimed first, then each rewrite claims the first free spelling.
        taken = {_RESERVED}
        taken.update(
            name.lower()
            for name in ParticipantGroup.objects.using(alias)
            .filter(event_id=event_id)
            .exclude(pk__in=[group.pk for group in groups])
            .values_list("name", flat=True)
        )
        for group in groups:
            base = comma_free_group_name(group.name) or _FALLBACK_NAME
            candidate = base
            suffix = 2
            while candidate.lower() in taken:
                tail = f" ({suffix})"
                candidate = f"{base[: _NAME_MAX_LENGTH - len(tail)]}{tail}"
                suffix += 1
            taken.add(candidate.lower())
            group.name = candidate
            group.save(update_fields=["name", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0009_backfill_participant_response_claims"),
    ]

    operations = [migrations.RunPython(drop_commas_from_group_names, migrations.RunPython.noop)]
