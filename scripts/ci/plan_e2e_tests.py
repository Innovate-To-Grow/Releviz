#!/usr/bin/env python3
"""Choose focused or full Playwright browser and spec coverage."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ALL_PROJECTS = ("chromium", "firefox", "webkit")
FULL_BROWSER_FILES = {
    "src/e2e/accessibility.spec.js",
    "src/e2e/playwright.config.js",
    "package-lock.json",
    "package.json",
}
FULL_BROWSER_PREFIXES = (".github/", "scripts/ci/", "src/web/next.config.js")


def read_changed_files(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def select_matrix(
    event_name: str,
    changed_files: list[str],
    *,
    full: bool = False,
) -> list[dict[str, str]]:
    if full or event_name != "pull_request" or not changed_files:
        return [{"project": project, "spec_args": ""} for project in ALL_PROJECTS]

    spec_files = sorted(
        path for path in changed_files if path.startswith("src/e2e/") and path.endswith(".spec.js")
    )
    spec_args = " ".join(spec_files)
    full_browser_coverage = any(
        path in FULL_BROWSER_FILES or path.startswith(FULL_BROWSER_PREFIXES)
        for path in changed_files
    )
    projects = ALL_PROJECTS if full_browser_coverage else ("chromium",)
    return [{"project": project, "spec_args": spec_args} for project in projects]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--event-name", default="")
    parser.add_argument("--changed-files", type=Path)
    args = parser.parse_args()

    if not args.full and (not args.event_name or args.changed_files is None):
        parser.error("--event-name and --changed-files are required unless --full is used")
    changed_files = read_changed_files(args.changed_files) if args.changed_files else []
    matrix = select_matrix(args.event_name, changed_files, full=args.full)
    compact = json.dumps(matrix, separators=(",", ":"))
    print(f"matrix={compact}")
    print(f"projects={json.dumps([item['project'] for item in matrix], separators=(',', ':'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
