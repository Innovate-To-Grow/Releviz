#!/usr/bin/env python3
"""Create an npm license inventory and reject strongly copyleft packages."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path


DENIED_LICENSES = re.compile(r"(?:^|[^A-Z])(AGPL|GPL|SSPL)(?:-|$)", re.IGNORECASE)


def package_inventory(lock: dict) -> list[dict[str, str]]:
    packages: list[dict[str, str]] = []
    for location, metadata in sorted(lock.get("packages", {}).items()):
        if not location or metadata.get("link"):
            continue
        name = metadata.get("name") or location.rsplit("node_modules/", 1)[-1]
        packages.append(
            {
                "name": name,
                "version": str(metadata.get("version", "unknown")),
                "license": str(metadata.get("license", "UNKNOWN")),
                "location": location,
            }
        )
    return packages


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-lock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    lock = json.loads(args.package_lock.read_text(encoding="utf-8"))
    packages = package_inventory(lock)
    denied = [item for item in packages if DENIED_LICENSES.search(item["license"])]
    counts = Counter(item["license"] for item in packages)
    report = {
        "package_count": len(packages),
        "licenses": dict(sorted(counts.items())),
        "denied": denied,
        "packages": packages,
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(
        f"Inspected {len(packages)} npm packages across {len(counts)} license expressions."
    )
    unknown = counts.get("UNKNOWN", 0)
    if unknown:
        print(
            f"WARNING: {unknown} package(s) did not declare a license in package-lock.json."
        )
    if denied:
        for item in denied:
            print(f"ERROR: {item['name']}@{item['version']} uses {item['license']}.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
