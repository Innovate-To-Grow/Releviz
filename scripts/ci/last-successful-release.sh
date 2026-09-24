#!/usr/bin/env bash
# Print the commit a production release surface last released successfully
# on main, or nothing when it has never been released.
#
#   scripts/ci/last-successful-release.sh <backend|frontend>
#
# Production releases run as one "Releviz Production Release" workflow whose
# surface jobs are reusable workflows, so a surface's history is the set of
# completed release.yml runs in which that surface's job concluded success —
# never the run as a whole, because a run where the backend released but the
# frontend failed must still count as a backend release, and one where a
# surface was skipped must not. Single-surface manual dispatches of the
# surface workflow, and every release made before the orchestrating workflow
# existed, live under the surface workflow's own run history; the newest of
# the two wins. Before the split, one workflow released everything, and its
# last success is the base until a surface has released once.
#
# Requires gh (with GH_TOKEN) and jq; reads only GitHub, never the cloud.
set -euo pipefail

surface="${1:-}"
case "$surface" in
  backend | frontend) ;;
  *)
    echo "usage: $0 <backend|frontend>" >&2
    exit 2
    ;;
esac

api() {
  gh api -H 'Accept: application/vnd.github+json' "$@"
}

# The newest completed orchestrated run whose surface job succeeded, as
# "<created_at>\t<head_sha>".
orchestrated_success() {
  local run_id created_at head_sha job_conclusion
  while IFS=$'\t' read -r run_id created_at head_sha; do
    [ -n "$run_id" ] || continue
    # A surface's job is named "<surface> / <job name>" in the orchestrating
    # run; the surface is one of two literal words, so it is safe to inline.
    job_conclusion="$(
      api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=100" \
        --jq "[.jobs[] | select(.name | startswith(\"${surface} / \")) | .conclusion] | first // \"\"" \
        2>/dev/null || true
    )"
    if [ "$job_conclusion" = "success" ]; then
      printf '%s\t%s\n' "$created_at" "$head_sha"
      return 0
    fi
  done < <(
    api "repos/${GITHUB_REPOSITORY}/actions/workflows/release.yml/runs?branch=main&status=completed&per_page=50" \
      --jq '.workflow_runs[]
        | select(.event == "workflow_run" or .event == "workflow_dispatch")
        | [(.id | tostring), .created_at, .head_sha] | @tsv' \
      2>/dev/null || true
  )
  return 0
}

# The newest successful run of a whole workflow file, as
# "<created_at>\t<head_sha>".
workflow_success() {
  api "repos/${GITHUB_REPOSITORY}/actions/workflows/$1/runs?branch=main&status=success&per_page=1" \
    --jq '.workflow_runs[0] | select(. != null) | [.created_at, .head_sha] | @tsv' \
    2>/dev/null || true
}

newest="$(
  {
    orchestrated_success
    workflow_success "release-${surface}.yml"
  } | sort | tail -n 1
)"
if [ -z "$newest" ]; then
  newest="$(workflow_success deploy-prod.yml)"
fi
sha="${newest#*$'\t'}"
if [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' "$sha"
fi
