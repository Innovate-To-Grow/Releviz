#!/usr/bin/env python3
"""Emit the full, sharded Playwright browser matrix for CI.

Every pull request, push, and manual dispatch runs every browser and every
spec: the "Full CI Scope" job in .github/workflows/ci.yml enables every area,
and a Chromium-only pass has let WebKit-only failures reach main before. The
planner therefore has one mode. ``--full`` is accepted so the workflow's
invocation reads as the policy it implements.
"""

from __future__ import annotations

import argparse
import json

ALL_PROJECTS = ("chromium", "firefox", "webkit")
# Each browser's suite is split across this many jobs. Playwright's --shard
# gives each job an even share of the tests, and the E2E Report job merges
# the shards' blob reports into one report.
SHARDS = 3


def select_matrix() -> list[dict[str, str | int]]:
    # `spec_args` stays in each entry because the workflow forwards it to
    # Playwright; it is always empty, so every spec runs. `shard_index` names
    # each shard's artifacts, which cannot contain the slash in `shard`.
    return [
        {"project": project, "shard": f"{index}/{SHARDS}", "shard_index": index, "spec_args": ""}
        for project in ALL_PROJECTS
        for index in range(1, SHARDS + 1)
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Print the full Playwright browser matrix.")
    parser.add_argument(
        "--full",
        action="store_true",
        help="Run every browser and every spec (the only mode).",
    )
    parser.parse_args()
    matrix = select_matrix()
    compact = json.dumps(matrix, separators=(",", ":"))
    print(f"matrix={compact}")
    print(f"projects={json.dumps(list(ALL_PROJECTS), separators=(',', ':'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
