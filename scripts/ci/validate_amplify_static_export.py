#!/usr/bin/env python3
"""Validate that the Amplify route manifest matches the Next static export."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / "src/web/amplify-routes.json"
DEFAULT_OUTPUT = ROOT / "src/web/out"
EXCLUDED_ROOT_HTML = {"404", "_not-found", "index"}


def _route_errors(routes: Any, label: str) -> tuple[set[str], list[str]]:
    errors: list[str] = []
    if not isinstance(routes, list) or not all(isinstance(route, str) for route in routes):
        return set(), [f"{label} must be an array of strings"]

    route_set = set(routes)
    if len(route_set) != len(routes):
        errors.append(f"{label} contains duplicate routes")
    for route in sorted(route_set):
        if not route or route != route.strip("/") or "/" in route or "." in route:
            errors.append(f"{label} route {route!r} must be a non-empty root route name")
    return route_set, errors


def _load_manifest(manifest_path: Path) -> tuple[set[str], dict[str, str], list[str]]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return set(), {}, [f"Amplify route manifest is missing: {manifest_path}"]
    except json.JSONDecodeError as error:
        return set(), {}, [f"Amplify route manifest is invalid JSON: {error}"]

    if not isinstance(manifest, dict):
        return set(), {}, ["Amplify route manifest must be a JSON object"]

    unexpected_keys = set(manifest) - {"legacy_redirects", "static_routes"}
    errors = (
        [f"Amplify route manifest has unexpected keys: {sorted(unexpected_keys)}"]
        if unexpected_keys
        else []
    )
    static_routes, route_errors = _route_errors(manifest.get("static_routes"), "static_routes")
    errors.extend(route_errors)

    legacy_redirects = manifest.get("legacy_redirects")
    if not isinstance(legacy_redirects, dict) or not all(
        isinstance(source, str) and isinstance(target, str)
        for source, target in legacy_redirects.items()
    ):
        errors.append("legacy_redirects must be an object of string route mappings")
        legacy_redirects = {}

    legacy_sources, source_errors = _route_errors(list(legacy_redirects), "legacy_redirects")
    errors.extend(source_errors)
    overlap = static_routes & legacy_sources
    if overlap:
        errors.append(f"static_routes and legacy_redirects overlap: {sorted(overlap)}")
    unknown_targets = set(legacy_redirects.values()) - static_routes
    if unknown_targets:
        errors.append(f"legacy_redirects targets are not static routes: {sorted(unknown_targets)}")

    return static_routes, legacy_redirects, errors


def amplify_static_export_errors(
    output_path: Path = DEFAULT_OUTPUT,
    manifest_path: Path = DEFAULT_MANIFEST,
) -> list[str]:
    """Return route/asset consistency errors for an Amplify static export."""

    static_routes, legacy_redirects, errors = _load_manifest(manifest_path)
    if not output_path.is_dir():
        return [*errors, f"Amplify static export is missing: {output_path}"]

    expected_routes = static_routes | set(legacy_redirects)
    actual_routes = {
        html_file.stem
        for html_file in output_path.glob("*.html")
        if html_file.stem not in EXCLUDED_ROOT_HTML
    }
    missing_routes = expected_routes - actual_routes
    unexpected_routes = actual_routes - expected_routes
    if missing_routes:
        errors.append(f"Amplify static export is missing route HTML: {sorted(missing_routes)}")
    if unexpected_routes:
        errors.append(
            f"Amplify static export has unlisted root route HTML: {sorted(unexpected_routes)}"
        )

    if not (output_path / "index.html").is_file():
        errors.append("Amplify static export is missing index.html")
    if not any(asset.is_file() for asset in (output_path / "_next/static").glob("**/*.js")):
        errors.append("Amplify static export has no _next/static JavaScript asset")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    errors = amplify_static_export_errors(args.out, args.manifest)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(
        "Amplify static export matches the shared route manifest and contains "
        "Next.js JavaScript assets."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
