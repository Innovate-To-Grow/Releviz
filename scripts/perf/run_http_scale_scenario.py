#!/usr/bin/env python3
"""Drive 1,000 schedule writes through HTTP with 100-way concurrency.

Use ``prepare_scale_scenario.py`` first.  This runner only targets loopback by
default, fixes the request paths, validates the fixture shape, and requires an
exact event-code confirmation before issuing writes.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import statistics
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

EXPECTED_PARTICIPANTS = 1_000
EXPECTED_SLOTS = 1_000
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure roster reads and 1,000 HTTP writes at 100-way concurrency."
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:4100")
    parser.add_argument("--event-code", required=True)
    parser.add_argument(
        "--confirm-code",
        required=True,
        help="Must exactly match --event-code before any schedule writes are sent.",
    )
    parser.add_argument("--request-count", type=int, default=EXPECTED_PARTICIPANTS)
    parser.add_argument("--concurrency", type=int, default=100)
    parser.add_argument("--roster-reads", type=int, default=20)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    parser.add_argument("--freshness-timeout-seconds", type=float, default=10.0)
    parser.add_argument("--assert-roster-p95-ms", type=float, default=3_000.0)
    parser.add_argument("--assert-write-p95-ms", type=float, default=2_000.0)
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--skip-results-freshness", action="store_true")
    parser.add_argument("--delete-manifest-on-success", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    args.event_code = args.event_code.strip().upper()
    if args.confirm_code.strip().upper() != args.event_code:
        parser.error("--confirm-code must exactly match --event-code")
    parsed_url = urlparse(args.base_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname:
        parser.error("--base-url must be an absolute http(s) URL")
    if parsed_url.hostname not in LOOPBACK_HOSTS and not args.allow_remote:
        parser.error("remote targets require --allow-remote")
    if args.request_count < 1 or args.request_count > EXPECTED_PARTICIPANTS:
        parser.error(f"--request-count must be between 1 and {EXPECTED_PARTICIPANTS}")
    if args.concurrency < 1 or args.concurrency > 100:
        parser.error("--concurrency must be between 1 and 100")
    if args.roster_reads < 0 or args.roster_reads > 100:
        parser.error("--roster-reads must be between 0 and 100")
    if args.timeout_seconds <= 0 or args.timeout_seconds > 300:
        parser.error("--timeout-seconds must be between 0 and 300")
    if args.freshness_timeout_seconds <= 0 or args.freshness_timeout_seconds > 120:
        parser.error("--freshness-timeout-seconds must be between 0 and 120")
    return args


def percentile(values: list[float], percentile_value: float) -> float:
    ordered = sorted(values)
    rank = max(1, math.ceil((percentile_value / 100) * len(ordered)))
    return ordered[rank - 1]


def load_manifest(path: Path, event_code: str) -> dict:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("eventCode") != event_code:
        raise RuntimeError("manifest eventCode does not match --event-code")
    if manifest.get("participantCount") != EXPECTED_PARTICIPANTS:
        raise RuntimeError(
            f"manifest must contain {EXPECTED_PARTICIPANTS} participants"
        )
    if manifest.get("slotCount") != EXPECTED_SLOTS:
        raise RuntimeError(f"manifest must describe {EXPECTED_SLOTS} slots")
    participants = manifest.get("participants")
    if not isinstance(participants, list) or len(participants) != EXPECTED_PARTICIPANTS:
        raise RuntimeError("manifest participant credentials are incomplete")
    if not manifest.get("organizer", {}).get("accessToken"):
        raise RuntimeError("manifest organizer credential is missing")
    return manifest


def request_json(
    *,
    method: str,
    url: str,
    access_token: str,
    timeout: float,
    body: bytes | None = None,
) -> tuple[int, dict, float]:
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {access_token}",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, data=body, headers=headers, method=method)
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - guarded URL
            raw = response.read()
            status = response.status
    except HTTPError as exc:
        raw = exc.read()
        status = exc.code
    except URLError as exc:
        return 0, {"error": str(exc)}, time.perf_counter() - started
    elapsed = time.perf_counter() - started
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {"error": raw[:300].decode("utf-8", errors="replace")}
    return status, payload, elapsed


def schedule_body(pattern_index: int, expected_version: int) -> bytes:
    inperson = [
        ((slot * 13 + pattern_index * 17) % 5) / 4 for slot in range(EXPECTED_SLOTS)
    ]
    virtual = [
        ((slot * 7 + pattern_index * 19 + 1) % 5) / 4 for slot in range(EXPECTED_SLOTS)
    ]
    return json.dumps(
        {
            "availabilityInperson": inperson,
            "availabilityVirtual": virtual,
            "submitted": 1,
            "expectedVersion": expected_version,
        },
        separators=(",", ":"),
    ).encode("utf-8")


def measure_roster(args: argparse.Namespace, manifest: dict) -> dict | None:
    if args.roster_reads == 0:
        return None
    query = urlencode({"code": args.event_code, "page": 1, "pageSize": 50})
    url = f"{args.base_url.rstrip('/')}/events/roster?{query}"
    token = manifest["organizer"]["accessToken"]
    durations = []
    failures = []
    for _ in range(args.roster_reads):
        status, payload, elapsed = request_json(
            method="GET",
            url=url,
            access_token=token,
            timeout=args.timeout_seconds,
        )
        durations.append(elapsed)
        if (
            status != 200
            or payload.get("pagination", {}).get("total") != EXPECTED_PARTICIPANTS
        ):
            failures.append(
                {"status": status, "error": payload.get("error", "invalid response")}
            )
    return {
        "requests": args.roster_reads,
        "failures": failures,
        "medianMs": round(statistics.median(durations) * 1_000, 2),
        "p95Ms": round(percentile(durations, 95) * 1_000, 2),
        "maximumMs": round(max(durations) * 1_000, 2),
    }


def submit_schedules(args: argparse.Namespace, manifest: dict) -> dict:
    participants = manifest["participants"][: args.request_count]
    body_cache = {
        (index % 20, int(item["expectedVersion"])): schedule_body(
            index % 20,
            int(item["expectedVersion"]),
        )
        for index, item in enumerate(participants)
    }

    def submit(index_and_item):
        index, item = index_and_item
        query = urlencode(
            {
                "code": args.event_code,
                "participantId": item["memberId"],
            }
        )
        url = f"{args.base_url.rstrip('/')}/events/participants/update?{query}"
        body = body_cache[(index % 20, int(item["expectedVersion"]))]
        status, payload, elapsed = request_json(
            method="PUT",
            url=url,
            access_token=item["accessToken"],
            timeout=args.timeout_seconds,
            body=body,
        )
        return {
            "index": index,
            "status": status,
            "elapsed": elapsed,
            "error": payload.get("error", "") if status < 200 or status >= 300 else "",
        }

    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency
    ) as executor:
        results = list(executor.map(submit, enumerate(participants)))
    wall_seconds = time.perf_counter() - started
    durations = [result["elapsed"] for result in results]
    failures = [
        result
        for result in results
        if result["status"] < 200 or result["status"] >= 300
    ]
    return {
        "requests": len(results),
        "concurrency": args.concurrency,
        "failures": failures[:20],
        "failureCount": len(failures),
        "wallSeconds": round(wall_seconds, 3),
        "throughputPerSecond": round(len(results) / wall_seconds, 2),
        "medianMs": round(statistics.median(durations) * 1_000, 2),
        "p95Ms": round(percentile(durations, 95) * 1_000, 2),
        "p99Ms": round(percentile(durations, 99) * 1_000, 2),
        "maximumMs": round(max(durations) * 1_000, 2),
    }


def wait_for_fresh_results(args: argparse.Namespace, manifest: dict) -> dict:
    query = urlencode({"code": args.event_code})
    url = f"{args.base_url.rstrip('/')}/events/results?{query}"
    token = manifest["organizer"]["accessToken"]
    started = time.perf_counter()
    deadline = started + args.freshness_timeout_seconds
    last_payload = {}
    polls = 0
    while time.perf_counter() < deadline:
        status, payload, _elapsed = request_json(
            method="GET",
            url=url,
            access_token=token,
            timeout=args.timeout_seconds,
        )
        polls += 1
        last_payload = payload
        if (
            status == 200
            and payload.get("status") == "fresh"
            and payload.get("requestedRevision") == payload.get("computedRevision")
        ):
            return {
                "fresh": True,
                "secondsAfterLastWrite": round(time.perf_counter() - started, 3),
                "polls": polls,
                "requestedRevision": payload.get("requestedRevision"),
                "computedRevision": payload.get("computedRevision"),
            }
        time.sleep(0.25)
    return {
        "fresh": False,
        "secondsAfterLastWrite": round(time.perf_counter() - started, 3),
        "polls": polls,
        "status": last_payload.get("status"),
        "requestedRevision": last_payload.get("requestedRevision"),
        "computedRevision": last_payload.get("computedRevision"),
        "error": last_payload.get("error") or last_payload.get("lastError", ""),
    }


def main() -> int:
    args = parse_args()
    manifest = load_manifest(args.manifest, args.event_code)
    roster = measure_roster(args, manifest)
    submissions = submit_schedules(args, manifest)
    freshness = (
        None if args.skip_results_freshness else wait_for_fresh_results(args, manifest)
    )
    summary = {
        "eventCode": args.event_code,
        "baseUrl": args.base_url,
        "roster": roster,
        "submissions": submissions,
        "resultsFreshness": freshness,
        "thresholds": {
            "rosterP95Ms": args.assert_roster_p95_ms,
            "writeP95Ms": args.assert_write_p95_ms,
            "resultsFreshnessSeconds": (
                None if args.skip_results_freshness else args.freshness_timeout_seconds
            ),
        },
    }
    failures = []
    if roster is not None:
        if roster["failures"]:
            failures.append(f"{len(roster['failures'])} roster reads failed")
        if roster["p95Ms"] > args.assert_roster_p95_ms:
            failures.append(
                f"roster p95 {roster['p95Ms']}ms exceeded {args.assert_roster_p95_ms}ms"
            )
    if submissions["failureCount"]:
        failures.append(f"{submissions['failureCount']} schedule writes failed")
    if submissions["p95Ms"] > args.assert_write_p95_ms:
        failures.append(
            f"write p95 {submissions['p95Ms']}ms exceeded {args.assert_write_p95_ms}ms"
        )
    if freshness is not None and not freshness["fresh"]:
        failures.append(
            f"results were not fresh within {args.freshness_timeout_seconds}s"
        )
    summary["passed"] = not failures
    summary["failureReasons"] = failures

    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        if roster is not None:
            print(
                f"Roster first page: p95={roster['p95Ms']:.2f}ms "
                f"max={roster['maximumMs']:.2f}ms failures={len(roster['failures'])}"
            )
        print(
            f"Schedule writes: requests={submissions['requests']} "
            f"concurrency={submissions['concurrency']} p95={submissions['p95Ms']:.2f}ms "
            f"throughput={submissions['throughputPerSecond']:.2f}/s "
            f"failures={submissions['failureCount']}"
        )
        if freshness is not None:
            print(
                "Results freshness: "
                f"fresh={freshness['fresh']} after={freshness['secondsAfterLastWrite']:.3f}s"
            )
        print("PASS" if not failures else f"FAIL: {'; '.join(failures)}")

    if not failures and args.delete_manifest_on_success:
        args.manifest.unlink()
        print(f"Deleted bearer-token manifest {args.manifest}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
