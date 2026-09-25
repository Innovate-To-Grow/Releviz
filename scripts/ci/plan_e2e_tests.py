#!/usr/bin/env python3
"""Emit the full Playwright browser matrix for CI.

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


def select_matrix() -> list[dict[str, str]]:
    # `spec_args` stays in each entry because the workflow forwards it to
    # Playwright; it is always empty, so every spec runs.
    return [{"project": project, "spec_args": ""} for project in ALL_PROJECTS]


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
    print(f"projects={json.dumps([item['project'] for item in matrix], separators=(',', ':'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
