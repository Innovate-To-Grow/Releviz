"""Result aggregation, recommendations, and cached snapshots."""

from .aggregation import (
    build_event_results,
    classify_event_responses,
    parse_availability,
    participant_availability,
    participant_has_valid_submission,
    participant_is_excluded,
    result_channels,
)
from .recommendations import MAX_RECOMMENDATIONS, build_ranked_recommendations
from .snapshots import (
    ensure_result_snapshot,
    flush_event_result_invalidations,
    mark_event_results_dirty,
    recompute_due_event_results,
    recompute_event_results,
    request_event_results_recompute,
    serialize_result_snapshot,
)

__all__ = [
    "MAX_RECOMMENDATIONS",
    "build_event_results",
    "build_ranked_recommendations",
    "classify_event_responses",
    "ensure_result_snapshot",
    "flush_event_result_invalidations",
    "mark_event_results_dirty",
    "parse_availability",
    "participant_availability",
    "participant_has_valid_submission",
    "participant_is_excluded",
    "recompute_due_event_results",
    "recompute_event_results",
    "request_event_results_recompute",
    "result_channels",
    "serialize_result_snapshot",
]
