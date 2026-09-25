#!/usr/bin/env python3
"""Emit the full Django app test matrix for CI.

Every pull request, push, and manual dispatch runs the PostgreSQL coverage job
for every app: the "Full CI Scope" job in .github/workflows/ci.yml enables
every area. The planner therefore has one mode. ``--full`` is accepted so the
workflow's invocation reads as the policy it implements.
"""

from __future__ import annotations

import argparse
import json

APPS = ("authn", "core", "mail", "scheduling")


def select_apps() -> list[str]:
    return list(APPS)


def main() -> int:
    parser = argparse.ArgumentParser(description="Print the full Django app test matrix.")
    parser.add_argument(
        "--full",
        action="store_true",
        help="Run every app's tests (the only mode).",
    )
    parser.parse_args()
    print(f"apps={json.dumps(select_apps(), separators=(',', ':'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
