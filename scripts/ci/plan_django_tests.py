#!/usr/bin/env python3
"""Select Django app test shards from a pull-request diff."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

APPS = ("authn", "core", "messaging", "scheduling")
APP_PATTERN = re.compile(r"^src/api/apps/([^/]+)/")
FULL_SUITE_PREFIXES = (
    ".github/",
    "scripts/",
    "src/api/requirements/",
    "src/api/config/",
)
FULL_SUITE_FILES = {
    ".pre-commit-config.yaml",
    "src/api/Dockerfile",
    "src/api/package.json",
    "src/api/pyproject.toml",
    "src/api/apps/__init__.py",
    "src/api/manage.py",
    "docker-compose.e2e.yml",
    "package-lock.json",
    "package.json",
}

# Changes to a foundational app can affect apps above it even when their source
# did not change directly. The full 100% coverage job still runs as a final
# safety net; this matrix provides focused PostgreSQL coverage and diagnostics.
IMPACT = {
    "authn": {"authn", "messaging", "scheduling"},
    "core": set(APPS),
    "messaging": {"messaging", "scheduling"},
    "scheduling": {"scheduling"},
}


def read_changed_files(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def select_apps(event_name: str, changed_files: list[str]) -> list[str]:
    if event_name != "pull_request" or not changed_files:
        return list(APPS)

    if any(
        path in FULL_SUITE_FILES or path.startswith(FULL_SUITE_PREFIXES) for path in changed_files
    ):
        return list(APPS)

    selected: set[str] = set()
    backend_change = False
    for path in changed_files:
        if not path.startswith("src/api/"):
            continue
        backend_change = True
        match = APP_PATTERN.match(path)
        if match and match.group(1) in IMPACT:
            selected.update(IMPACT[match.group(1)])

    if backend_change and not selected:
        return list(APPS)
    return [app for app in APPS if app in selected]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-name", required=True)
    parser.add_argument("--changed-files", type=Path, required=True)
    args = parser.parse_args()

    apps = select_apps(args.event_name, read_changed_files(args.changed_files))
    print(f"apps={json.dumps(apps, separators=(',', ':'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
