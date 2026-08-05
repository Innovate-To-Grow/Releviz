#!/usr/bin/env python3
"""Benchmark the production recommendation algorithm without database or HTTP I/O.

The default fixture is the release acceptance shape: 1,000 submitted people,
1,000 authoritative slots, mixed (in-person + virtual) mode, and a 60-minute
meeting duration.  It deliberately imports the scheduling slot builder and
recommendation implementation from ``src/backend`` so this is not a toy
replacement for the application algorithm.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "src" / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

from apps.scheduling.recommendations import build_ranked_recommendations  # noqa: E402
from apps.scheduling.slots import build_event_slot_groups  # noqa: E402


PARTICIPANT_TOTAL = 1_000
DATE_TOTAL = 25
SLOTS_PER_DATE = 40
SLOT_TOTAL = DATE_TOTAL * SLOTS_PER_DATE
CHANNELS = ("inperson", "virtual")


@dataclass
class BenchmarkEvent:
    code: str = "PERF1000"
    mode: str = "mixed"
    timezone: str = "UTC"
    day_selection_type: str = "specific_dates"
    slot_minutes: int = 15
    meeting_duration_minutes: int = 60
    start_minutes: int = 9 * 60
    end_minutes: int = 19 * 60
    spans_next_day: bool = False
    days: list[int] = field(default_factory=list)
    specific_dates: list[str] = field(default_factory=list)


def percentile(values: list[float], percentile_value: float) -> float:
    """Return a nearest-rank percentile suitable for an acceptance gate."""

    ordered = sorted(values)
    rank = max(1, math.ceil((percentile_value / 100) * len(ordered)))
    return ordered[rank - 1]


def benchmark_event() -> BenchmarkEvent:
    first_date = date.today() + timedelta(days=1)
    dates = [
        (first_date + timedelta(days=offset)).isoformat()
        for offset in range(DATE_TOTAL)
    ]
    return BenchmarkEvent(specific_dates=dates)


def participant_availability(participant_index: int, channel_index: int) -> list[float]:
    """Produce deterministic, varied 0/.25/.5/.75/1 scores."""

    return [
        ((participant_index * 17 + slot_index * 13 + channel_index * 7) % 5) / 4
        for slot_index in range(SLOT_TOTAL)
    ]


def fixture() -> tuple[BenchmarkEvent, dict]:
    event = benchmark_event()
    groups = build_event_slot_groups(event)
    actual_slot_total = sum(len(group.slots) for group in groups)
    if actual_slot_total != SLOT_TOTAL:
        raise RuntimeError(f"expected {SLOT_TOTAL} slots, built {actual_slot_total}")

    counted = []
    for participant_index in range(PARTICIPANT_TOTAL):
        # Include zero-weight responses in the unweighted score while excluding
        # their influence from the weighted score, matching production behavior.
        weight = (
            0.0 if participant_index % 20 == 0 else ((participant_index % 10) + 1) / 10
        )
        counted.append(
            {
                "availability": {
                    channel: participant_availability(participant_index, channel_index)
                    for channel_index, channel in enumerate(CHANNELS)
                },
                "weight": weight,
            }
        )
    return event, {"counted": counted, "unanswered": [], "excluded": []}


def calculate(event: BenchmarkEvent, classified: dict) -> dict:
    """Run the production-equivalent aggregate pass and production ranking."""

    counted = classified["counted"]
    unweighted_totals = {channel: [0.0] * SLOT_TOTAL for channel in CHANNELS}
    weighted_totals = {channel: [0.0] * SLOT_TOTAL for channel in CHANNELS}
    total_weight = 0.0

    for entry in counted:
        weight = entry["weight"]
        if weight > 0:
            total_weight += weight
        for channel in CHANNELS:
            values = entry["availability"][channel]
            unweighted = unweighted_totals[channel]
            weighted = weighted_totals[channel]
            for slot_index, value in enumerate(values):
                unweighted[slot_index] += value
                if weight > 0:
                    weighted[slot_index] += value * weight

    channel_results = {
        channel: {
            "unweighted": [
                value / PARTICIPANT_TOTAL for value in unweighted_totals[channel]
            ],
            "weighted": [value / total_weight for value in weighted_totals[channel]],
        }
        for channel in CHANNELS
    }
    recommendations, basis = build_ranked_recommendations(
        event,
        classified=classified,
        channel_results=channel_results,
        now=datetime.combine(date.today(), datetime.min.time(), tzinfo=UTC),
    )
    return {"recommendations": recommendations, "basis": basis}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the 1,000-person × 1,000-slot × two-channel aggregation benchmark."
    )
    parser.add_argument(
        "--runs", type=int, default=3, help="Measured runs (default: 3)."
    )
    parser.add_argument(
        "--warmup-runs",
        type=int,
        default=0,
        help="Unmeasured warm-up runs (default: 0; each run is full scale).",
    )
    parser.add_argument(
        "--assert-p95-seconds",
        type=float,
        help="Exit non-zero when measured p95 exceeds this threshold.",
    )
    parser.add_argument(
        "--json", action="store_true", help="Print machine-readable JSON."
    )
    args = parser.parse_args()
    if args.runs < 1 or args.runs > 20:
        parser.error("--runs must be between 1 and 20")
    if args.warmup_runs < 0 or args.warmup_runs > 5:
        parser.error("--warmup-runs must be between 0 and 5")
    if args.assert_p95_seconds is not None and args.assert_p95_seconds <= 0:
        parser.error("--assert-p95-seconds must be positive")
    return args


def main() -> int:
    args = parse_args()
    fixture_started = time.perf_counter()
    event, classified = fixture()
    fixture_seconds = time.perf_counter() - fixture_started

    for _ in range(args.warmup_runs):
        calculate(event, classified)

    durations = []
    last_result = None
    for _ in range(args.runs):
        started = time.perf_counter()
        last_result = calculate(event, classified)
        durations.append(time.perf_counter() - started)

    assert last_result is not None
    recommendations = last_result["recommendations"]
    if len(recommendations) != 10:
        raise RuntimeError(
            f"expected 10 ranked recommendations, got {len(recommendations)}"
        )
    p95_seconds = percentile(durations, 95)
    summary = {
        "shape": {
            "participants": PARTICIPANT_TOTAL,
            "slots": SLOT_TOTAL,
            "channels": len(CHANNELS),
            "meetingDurationMinutes": event.meeting_duration_minutes,
        },
        "fixtureSeconds": round(fixture_seconds, 4),
        "runs": args.runs,
        "seconds": [round(value, 4) for value in durations],
        "medianSeconds": round(statistics.median(durations), 4),
        "p95Seconds": round(p95_seconds, 4),
        "maximumSeconds": round(max(durations), 4),
        "recommendationCount": len(recommendations),
        "bestRecommendation": {
            "channel": recommendations[0]["channel"],
            "slotIndex": recommendations[0]["slotIndex"],
            "durationMinutes": recommendations[0]["durationMinutes"],
            "weightedAvailability": recommendations[0]["weightedAvailability"],
        },
    }
    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        shape = summary["shape"]
        print(
            "Aggregation shape: "
            f"{shape['participants']} participants × {shape['slots']} slots × "
            f"{shape['channels']} channels"
        )
        print(f"Fixture construction: {summary['fixtureSeconds']:.4f}s")
        print(f"Measured seconds: {summary['seconds']}")
        print(
            f"median={summary['medianSeconds']:.4f}s "
            f"p95={summary['p95Seconds']:.4f}s max={summary['maximumSeconds']:.4f}s"
        )

    if args.assert_p95_seconds is not None and p95_seconds > args.assert_p95_seconds:
        print(
            f"FAIL: p95 {p95_seconds:.4f}s exceeded {args.assert_p95_seconds:.4f}s",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
