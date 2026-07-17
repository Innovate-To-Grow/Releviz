#!/usr/bin/env python3
"""Enforce simple, reviewable budgets for emitted frontend assets."""

from __future__ import annotations

import argparse
from pathlib import Path


ASSET_SUFFIXES = {".css", ".js", ".mjs"}


def collect_assets(root: Path) -> list[tuple[Path, int]]:
    if not root.is_dir():
        raise FileNotFoundError(f"Bundle directory does not exist: {root}")
    return sorted(
        (
            (path, path.stat().st_size)
            for path in root.rglob("*")
            if path.is_file() and path.suffix in ASSET_SUFFIXES
        ),
        key=lambda item: item[1],
        reverse=True,
    )


def check_budgets(
    assets: list[tuple[Path, int]], *, max_total_bytes: int, max_file_bytes: int
) -> list[str]:
    failures: list[str] = []
    total = sum(size for _, size in assets)
    if not assets:
        failures.append("No JavaScript or CSS assets were found.")
    if total > max_total_bytes:
        failures.append(
            f"Total assets are {total} bytes; budget is {max_total_bytes} bytes."
        )
    oversized = [(path, size) for path, size in assets if size > max_file_bytes]
    for path, size in oversized:
        failures.append(
            f"{path} is {size} bytes; per-file budget is {max_file_bytes} bytes."
        )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle_dir", type=Path)
    parser.add_argument("--max-total-kib", type=int, default=4096)
    parser.add_argument("--max-file-kib", type=int, default=1536)
    args = parser.parse_args()

    try:
        assets = collect_assets(args.bundle_dir)
    except FileNotFoundError as exc:
        print(exc)
        return 1

    total = sum(size for _, size in assets)
    print(f"Bundle assets: {len(assets)} files, {total / 1024:.1f} KiB total")
    for path, size in assets[:10]:
        print(f"  {size / 1024:8.1f} KiB  {path}")

    failures = check_budgets(
        assets,
        max_total_bytes=args.max_total_kib * 1024,
        max_file_bytes=args.max_file_kib * 1024,
    )
    for failure in failures:
        print(f"ERROR: {failure}")
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
