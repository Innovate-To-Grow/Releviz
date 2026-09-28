#!/usr/bin/env python3
"""Rerun a CI run's failed jobs once when the infrastructure, not the code, failed them.

``.github/workflows/ci-retry.yml`` runs this after the first attempt of a CI
run fails. A job that hit a registry rate limit, lost its connection to a
package index, or lost its runner never checked the code, and the same job
usually passes minutes later on another runner. The script reads the log and
annotations of every failed job and asks GitHub to rerun the run's failed jobs
only when at least one of them shows such an error. A failure with no such
error, such as a failing test or lint check, is left for a person.

A run that a newer run on the same branch has superseded is never retried.
On main a green rerun triggers a production release, and releasing an older
commit after a newer one would roll production back.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from urllib.parse import quote

API_ROOT = "https://api.github.com/"

# Errors that come from the machines and services a job depends on rather
# than from the code it checks. Each pattern is narrow enough that a test's
# own output does not match it.
TRANSIENT_ERRORS = {
    # ECR Public, Docker Hub and GHCR all answer a rate-limited pull (a
    # service container, a Dockerfile base image, Trivy's database) with this
    # error code. It is matched as a code so that SES's own
    # TooManyRequestsException in a test's output does not count.
    "registry rate limit": re.compile(r"\b(?:toomanyrequests|TOOMANYREQUESTS): "),
    "npm registry unreachable": re.compile(
        r"npm (?:ERR!|error) (?:code (?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|network )"
    ),
    "Python package index unreachable": re.compile(
        r"HTTPSConnectionPool\(host='(?:pypi\.org|files\.pythonhosted\.org)', port=443\): "
        r"(?:Max retries exceeded|Read timed out)"
    ),
    "apt mirror unreachable": re.compile(r"\bE: Failed to fetch https?://"),
    "browser download failed": re.compile(r"Failed to download (?:Chromium|Firefox|WebKit|FFMPEG)"),
    "download failed": re.compile(r"curl: \((?:6|28|35|52|56)\) "),
    "GitHub unreachable": re.compile(
        r"unable to access 'https://github\.com/[^']*': "
        r"(?:The requested URL returned error: 5\d\d|Could not resolve host|Failed to connect)"
    ),
    "runner lost": re.compile(
        r"lost communication with the server|The runner has received a shutdown signal"
    ),
}


def transient_errors(text: str) -> list[str]:
    """Name every kind of infrastructure error that ``text`` shows."""

    return [label for label, pattern in TRANSIENT_ERRORS.items() if pattern.search(text)]


def retry_decision(
    run: dict,
    *,
    newest_run_id: int | None,
    branch_tip: str | None,
    failures: dict[str, list[str]],
) -> tuple[bool, str]:
    """Whether to rerun ``run``'s failed jobs, and the reason either way.

    ``newest_run_id`` is the latest CI run for the same branch and event, and
    ``branch_tip`` the branch's current commit (only known for pushes).
    ``failures`` maps each failed job's name to the infrastructure errors its
    log and annotations show, empty when there were none.

    Run ids only grow, so a run supersedes this one only when its id is
    larger. The runs listing has been seen to answer with a months-old run
    first, which must not stop a retry.
    """

    branch = run.get("head_branch") or "its branch"
    if run.get("run_attempt") != 1:
        return False, "only a run's first attempt is retried automatically"
    if newest_run_id is not None and newest_run_id > run["id"]:
        return False, f"run {newest_run_id} on {branch} is newer and supersedes this one"
    if branch_tip is not None and branch_tip != run["head_sha"]:
        return False, f"{branch} has moved on to {branch_tip[:7]}"
    if not failures:
        return False, "no job failed"
    transient = sorted(name for name, errors in failures.items() if errors)
    if not transient:
        return False, "no failed job shows an infrastructure error"
    return True, f"infrastructure errors in: {', '.join(transient)}"


def render_summary(retry: bool, reason: str, failures: dict[str, list[str]]) -> str:
    lines = [
        "## CI retry",
        "",
        f"**{'Rerunning the failed jobs' if retry else 'Not retrying'}**: {reason}.",
    ]
    if failures:
        lines += ["", "| Failed job | Infrastructure errors |", "|---|---|"]
        for name in sorted(failures):
            lines.append(f"| {name} | {', '.join(failures[name]) or 'none'} |")
    return "\n".join(lines) + "\n"


def gh_api(path: str, *args: str) -> str:
    result = subprocess.run(
        ["gh", "api", *args, path.removeprefix(API_ROOT)],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def job_text(job: dict) -> str:
    """The failed job's log followed by its annotations.

    A job whose runner was lost may have no log at all, and the reason it
    failed is then only in its annotations.
    """

    parts = []
    try:
        parts.append(
            gh_api(f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/jobs/{job['id']}/logs")
        )
    except subprocess.CalledProcessError:
        pass
    annotations = json.loads(gh_api(f"{job['check_run_url']}/annotations?per_page=100"))
    parts += [annotation.get("message") or "" for annotation in annotations]
    return "\n".join(parts)


def main() -> int:
    repository = os.environ["GITHUB_REPOSITORY"]
    run_id = os.environ["CI_RUN_ID"]
    run = json.loads(gh_api(f"repos/{repository}/actions/runs/{run_id}"))
    branch = run["head_branch"]

    newest = json.loads(
        gh_api(
            f"repos/{repository}/actions/workflows/{run['workflow_id']}/runs"
            f"?branch={quote(branch, safe='')}&event={run['event']}&per_page=1"
        )
    )["workflow_runs"]
    branch_tip = None
    if run["event"] == "push":
        ref = json.loads(gh_api(f"repos/{repository}/git/ref/heads/{quote(branch, safe='/')}"))
        branch_tip = ref["object"]["sha"]

    jobs = json.loads(
        gh_api(
            f"repos/{repository}/actions/runs/{run_id}/attempts/{run['run_attempt']}/jobs"
            "?per_page=100"
        )
    )["jobs"]
    failures = {
        job["name"]: transient_errors(job_text(job))
        for job in jobs
        if job.get("conclusion") == "failure"
    }

    retry, reason = retry_decision(
        run,
        newest_run_id=newest[0]["id"] if newest else None,
        branch_tip=branch_tip,
        failures=failures,
    )
    summary = render_summary(retry, reason, failures)
    print(summary)
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(summary)
    if retry:
        try:
            gh_api(f"repos/{repository}/actions/runs/{run_id}/rerun-failed-jobs", "-X", "POST")
        except subprocess.CalledProcessError as error:
            print(f"::error::Could not rerun run {run_id}: {error.stderr.strip()}", file=sys.stderr)
            return 1
        print(f"::notice::Rerunning the failed jobs of run {run_id}: {reason}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
