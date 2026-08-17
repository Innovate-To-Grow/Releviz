#!/usr/bin/env python3
"""Ensure labels requested by Dependabot exist in the GitHub repository."""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def configured_labels(config: dict) -> set[str]:
    labels: set[str] = set()
    for update in config.get("updates", []):
        labels.update(str(label) for label in update.get("labels", []))
    return labels


def main() -> int:
    config_path = ROOT / ".github/dependabot.yml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    labels = configured_labels(config)
    if not labels:
        print("Dependabot does not request custom labels.")
        return 0

    repository = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GH_TOKEN", "")
    if not repository or not token:
        print(
            "GITHUB_REPOSITORY and GH_TOKEN are required to validate labels.",
            file=sys.stderr,
        )
        return 1

    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/labels?per_page=100",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
        existing = {item["name"] for item in json.load(response)}
    missing = sorted(labels - existing)
    if missing:
        print(f"Missing Dependabot labels: {', '.join(missing)}", file=sys.stderr)
        return 1
    print(f"Validated {len(labels)} Dependabot label(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
