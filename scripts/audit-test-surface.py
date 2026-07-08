#!/usr/bin/env python3
"""Ensure tracked non-runtime assets stay visible to tests or explicit tooling."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUDITED_SUFFIXES = {
    ".css",
    ".html",
    ".ico",
    ".md",
    ".png",
    ".sh",
    ".svg",
    ".tf",
    ".txt",
    ".yml",
}
AUDITED_NAMES = {
    ".dockerignore",
    ".gitignore",
    ".prettierignore",
    ".prettierrc",
    "Dockerfile",
    "docker-entrypoint.sh",
    "eslint.config.mjs",
    "jest.config.js",
    "jsconfig.json",
    "next.config.js",
    "package-lock.json",
    "package.json",
    "playwright.config.js",
    "pyproject.toml",
}
REFERENCE_FILES = [
    "backend/src/apps/core/tests/test_admin_theme.py",
    "backend/src/apps/core/tests/test_repository_surface.py",
    "e2e/repository-surface.spec.js",
]


def tracked_files() -> list[str]:
    output = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True)
    untracked = subprocess.check_output(
        ["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT, text=True
    )
    return sorted({line for line in [*output.splitlines(), *untracked.splitlines()] if line})


def should_audit(path: str) -> bool:
    name = Path(path).name
    suffix = Path(path).suffix
    if path.startswith(
        (
            "node_modules/",
            "coverage/",
            "htmlcov/",
            "frontend/.next/",
            "frontend/coverage/",
            "frontend/playwright-report/",
            "frontend/test-results/",
            "e2e/playwright-report/",
            "e2e/test-results/",
            "playwright-report/",
            "test-results/",
        )
    ):
        return False
    return suffix in AUDITED_SUFFIXES or name in AUDITED_NAMES


def main() -> int:
    tracked = tracked_files()
    references = "\n".join(
        (ROOT / file).read_text(encoding="utf-8") for file in REFERENCE_FILES if (ROOT / file).exists()
    )
    missing = [path for path in tracked if should_audit(path) and path not in references]
    if missing:
        print("Repository files are not covered by the resource audit manifest:", file=sys.stderr)
        for path in missing:
            print(f"  - {path}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
