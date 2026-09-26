"""Which roster rows a request names: explicit ids, a group, or a filter.

Bulk edits and invitation sends share this grammar so one selection means
the same people to both.
"""

from apps.scheduling.services.roster_imports import MAX_ROSTER_ROWS, RosterImportError

from .helpers import participant_identity_query
from .queries import UNGROUPED_FILTER, apply_roster_filters

SELECTION_FILTER_KEYS = {
    "all",
    "search",
    "group",
    "submitted",
    "included",
    "invitationStatus",
    "accountAccess",
}


def parse_participant_ids(value) -> list:
    """A non-empty list of at most ``MAX_ROSTER_ROWS`` participant identities."""

    if not isinstance(value, list) or not value:
        raise RosterImportError("participantIds must be a non-empty array.")
    if len(value) > MAX_ROSTER_ROWS:
        raise RosterImportError(f"participantIds may contain at most {MAX_ROSTER_ROWS} entries.")
    return value


def parse_selection_filter(value) -> dict:
    """A ``filter`` object: known keys only, never empty, ``all`` only as ``true``."""

    if not isinstance(value, dict):
        raise RosterImportError("filter must be an object.")
    unknown_filters = set(value) - SELECTION_FILTER_KEYS
    if unknown_filters:
        raise RosterImportError(f"Unknown participant filter: {sorted(unknown_filters)[0]}.")
    if not value:
        raise RosterImportError("filter must contain a participant filter or explicit all=true.")
    if "all" in value and value.get("all") is not True:
        raise RosterImportError("filter.all must be true when provided.")
    return value


def invitation_selection(data) -> tuple[list | None, dict | None]:
    """The people an invitation send names: ``participantIds`` or ``filter``, never both."""

    participant_ids = data.get("participantIds")
    filter_data = data.get("filter")
    if (participant_ids is None) == (filter_data is None):
        raise RosterImportError("Provide participantIds or filter.")
    if participant_ids is not None:
        return parse_participant_ids(participant_ids), None
    return None, parse_selection_filter(filter_data)


def bulk_selector(queryset, data):
    """Narrow ``queryset`` to the rows a bulk edit names; selectors combine."""

    has_selector = False
    if data.get("participantIds") is not None:
        has_selector = True
        queryset = queryset.filter(
            participant_identity_query(parse_participant_ids(data.get("participantIds")))
        )
    if "group" in data:
        has_selector = True
        group_name = str(data.get("group") or "").strip()
        # A name selects its explicit members plus everyone flagged for all
        # groups; a blank name selects the people in no group at all.
        queryset = apply_roster_filters(queryset, {"group": group_name or UNGROUPED_FILTER})
    if "filter" in data:
        has_selector = True
        queryset = apply_roster_filters(queryset, parse_selection_filter(data.get("filter")))
    if not has_selector:
        raise RosterImportError("Choose participantIds, group, or filter for a bulk update.")
    return queryset
