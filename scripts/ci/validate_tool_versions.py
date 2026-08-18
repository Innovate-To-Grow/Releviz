#!/usr/bin/env python3
"""Keep important CI tools explicitly and consistently version-pinned."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
BACKEND_DOCKERFILE = ROOT / "src/api/Dockerfile"

REQUIRED_FRAGMENTS = (
    'PYTHON_VERSION: "3.14"',
    'NODE_VERSION: "24"',
    'TERRAFORM_VERSION: "1.15.8"',
    'UV_VERSION: "0.9.26"',
    'PIP_AUDIT_VERSION: "2.10.1"',
    'SEMGREP_VERSION: "1.170.0"',
    'ACTIONLINT_VERSION: "1.7.7"',
    'GITLEAKS_VERSION: "8.21.2"',
    "actions/checkout@v7",
    "actions/setup-python@v7",
    "actions/setup-node@v7",
    "actions/cache@v6",
    "actions/upload-artifact@v7",
    "actions/download-artifact@v8",
    "hashicorp/setup-terraform@v4",
    "actionlint .github/workflows/deploy-prod.yml.disabled",
    "semgrep scan \\\n            --error",
    "bash scripts/compile-api-requirements.sh --check",
)


def missing_fragments(text: str) -> list[str]:
    return [fragment for fragment in REQUIRED_FRAGMENTS if fragment not in text]


def main() -> int:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    missing = missing_fragments(workflow)
    unhashed_installs = [
        line.strip()
        for line in workflow.splitlines()
        if "python -m pip install" in line
        and "requirements/local.txt" in line
        and "--require-hashes" not in line
    ]
    dockerfile = BACKEND_DOCKERFILE.read_text(encoding="utf-8")
    if "--require-hashes -r requirements/production.txt" not in dockerfile:
        missing.append("Docker production dependency install must use --require-hashes")
    missing.extend(f"unhashed backend CI install: {line}" for line in unhashed_installs)
    if missing:
        print("CI tool-version validation failed:", file=sys.stderr)
        for fragment in missing:
            print(f"  missing: {fragment}", file=sys.stderr)
        return 1
    print(f"Validated {len(REQUIRED_FRAGMENTS)} CI tool/action pins.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
