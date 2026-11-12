#!/usr/bin/env python3
"""Fail npm audit unless every advisory is specifically accepted.

`npm audit` has no ignore file. The allowlist below is the only accepted
exception, and it is limited to one dev-only advisory with no patched release.
"""

from __future__ import annotations

import json
import subprocess
import sys

# deepmerge 4.3.1 is the newest release. GHSA-gcqx-w48m-w2h4 covers
# >=4.2.0,<=4.3.1 and lists no patched version. Jest uses the package to merge
# its own configuration; the production image does not include it. npm's
# suggested fix downgrades jest to 25.
ALLOWED_ADVISORIES = {
    ("deepmerge", "GHSA-gcqx-w48m-w2h4"),
}


def advisory_id(url: str) -> str:
    marker = "/advisories/"
    if marker not in url:
        return url
    return url.rsplit(marker, 1)[-1].strip("/")


def unapproved_advisories(report: dict) -> list[str]:
    findings: list[str] = []
    for name, info in sorted(report.get("vulnerabilities", {}).items()):
        for via in info.get("via", []):
            if not isinstance(via, dict):
                continue
            ghsa = advisory_id(str(via.get("url", "")))
            if (name, ghsa) in ALLOWED_ADVISORIES:
                continue
            severity = via.get("severity", "unknown")
            title = via.get("title", "")
            findings.append(f"{severity} {name} {ghsa}: {title}")
    return findings


def main() -> int:
    completed = subprocess.run(
        ["npm", "audit", "--json"],
        check=False,
        capture_output=True,
        text=True,
    )
    try:
        report = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        sys.stderr.write(completed.stderr)
        sys.stderr.write("npm audit did not return JSON.\n")
        return 1
    if report.get("error"):
        print(report["error"], file=sys.stderr)
        return 1
    findings = unapproved_advisories(report)
    if findings:
        print("npm audit found advisories that are not allowlisted:", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        return 1
    accepted = sorted(ALLOWED_ADVISORIES)
    print(
        "npm audit passed. "
        f"Allowlisted dev-only advisory with no patched release: {', '.join(f'{name} {ghsa}' for name, ghsa in accepted)}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
