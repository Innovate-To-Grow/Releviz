#!/usr/bin/env python3
"""Keep important CI tools explicitly and consistently version-pinned."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"

REQUIRED_FRAGMENTS = (
    'PYTHON_VERSION: "3.11"',
    'NODE_VERSION: "24"',
    'TERRAFORM_VERSION: "1.15.8"',
    'PIP_AUDIT_VERSION: "2.10.1"',
    'SEMGREP_VERSION: "1.107.0"',
    'ACTIONLINT_VERSION: "1.7.7"',
    'GITLEAKS_VERSION: "8.21.2"',
    "actions/checkout@v7",
    "actions/setup-python@v6",
    "actions/setup-node@v6",
    "actions/cache@v6",
    "actions/upload-artifact@v7",
    "actions/download-artifact@v8",
    "hashicorp/setup-terraform@v3",
)


def missing_fragments(text: str) -> list[str]:
    return [fragment for fragment in REQUIRED_FRAGMENTS if fragment not in text]


def main() -> int:
    missing = missing_fragments(WORKFLOW.read_text(encoding="utf-8"))
    if missing:
        print("CI tool-version validation failed:", file=sys.stderr)
        for fragment in missing:
            print(f"  missing: {fragment}", file=sys.stderr)
        return 1
    print(f"Validated {len(REQUIRED_FRAGMENTS)} CI tool/action pins.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
