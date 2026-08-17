#!/usr/bin/env python3
"""Render GitHub Actions job timings as a Markdown summary."""

from __future__ import annotations

import json
import sys
from datetime import datetime


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def duration_seconds(job: dict) -> float:
    started = parse_time(job.get("started_at"))
    completed = parse_time(job.get("completed_at"))
    if not started or not completed:
        return 0.0
    return max(0.0, (completed - started).total_seconds())


def render(payload: dict) -> str:
    jobs = sorted(payload.get("jobs", []), key=duration_seconds, reverse=True)
    lines = [
        "## CI job timing",
        "",
        "| Job | Result | Duration |",
        "|---|---|---:|",
    ]
    for job in jobs:
        duration = duration_seconds(job)
        result = job.get("conclusion") or job.get("status", "unknown")
        lines.append(f"| {job.get('name', 'unknown')} | {result} | {duration:.1f}s |")
    lines.append("")
    lines.append(
        f"Total runner time across {len(jobs)} jobs: {sum(map(duration_seconds, jobs)):.1f}s."
    )
    return "\n".join(lines)


def main() -> int:
    payload = json.load(sys.stdin)
    print(render(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
