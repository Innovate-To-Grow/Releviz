#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: amplify-static-deploy.sh <app-id> <branch-name> <static-zip>" >&2
}

if [ "$#" -ne 3 ]; then
  usage
  exit 64
fi

app_id="$1"
branch_name="$2"
archive="$3"
poll_seconds="${AMPLIFY_POLL_SECONDS:-10}"
timeout_seconds="${AMPLIFY_TIMEOUT_SECONDS:-1800}"
stop_attempts="${AMPLIFY_STOP_ATTEMPTS:-5}"
cancel_polls_per_attempt="${AMPLIFY_CANCEL_POLLS_PER_ATTEMPT:-12}"
cancel_poll_seconds="${AMPLIFY_CANCEL_POLL_SECONDS:-5}"
readonly AMPLIFY_CANCELLATION_UNCONFIRMED_EXIT_CODE=75
job_id=""
deployment_terminal=false

persist_evidence() {
  local key="$1"
  local value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"
  fi
}

job_status() {
  aws amplify get-job \
    --app-id "$app_id" \
    --branch-name "$branch_name" \
    --job-id "$job_id" \
    --query "job.summary.status" \
    --output text 2>/dev/null ||
    true
}

is_terminal_status() {
  case "$1" in
    SUCCEED | FAILED | CANCELLED)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

stop_and_confirm_terminal() {
  local last_status=""
  local stop_attempt
  local poll_attempt
  for stop_attempt in $(seq 1 "$stop_attempts"); do
    last_status="$(job_status)"
    if is_terminal_status "$last_status"; then
      persist_evidence "status" "$last_status"
      persist_evidence "terminal_confirmed" "true"
      persist_evidence "cancellation_confirmed" "$(
        if [ "$last_status" = "CANCELLED" ]; then printf true; else printf false; fi
      )"
      echo \
        "Amplify deployment is terminal: branch=${branch_name}, job=${job_id}, status=${last_status}" \
        >&2
      return 0
    fi

    echo \
      "Requesting Amplify deployment cancellation: branch=${branch_name}, job=${job_id}, attempt=${stop_attempt}/${stop_attempts}" \
      >&2
    if ! aws amplify stop-job \
      --app-id "$app_id" \
      --branch-name "$branch_name" \
      --job-id "$job_id" \
      >/dev/null; then
      echo \
        "Amplify stop-job request failed; the terminal-status check will be retried." \
        >&2
    fi

    for poll_attempt in $(seq 1 "$cancel_polls_per_attempt"); do
      last_status="$(job_status)"
      if is_terminal_status "$last_status"; then
        persist_evidence "status" "$last_status"
        persist_evidence "terminal_confirmed" "true"
        persist_evidence "cancellation_confirmed" "$(
          if [ "$last_status" = "CANCELLED" ]; then printf true; else printf false; fi
        )"
        echo \
          "Amplify deployment is terminal: branch=${branch_name}, job=${job_id}, status=${last_status}" \
          >&2
        return 0
      fi
      echo \
        "Waiting for Amplify deployment terminal status: branch=${branch_name}, job=${job_id}, status=${last_status:-UNKNOWN}, cancellation_attempt=${stop_attempt}/${stop_attempts}, poll=${poll_attempt}/${cancel_polls_per_attempt}" \
        >&2
      sleep "$cancel_poll_seconds"
    done
  done

  persist_evidence "status" "${last_status:-UNKNOWN}"
  persist_evidence "terminal_confirmed" "false"
  persist_evidence "cancellation_confirmed" "false"
  echo \
    "::error title=Amplify cancellation unconfirmed::Could not confirm a terminal status for branch=${branch_name}, job=${job_id}, last_status=${last_status:-UNKNOWN}. Do not start a retry or rollback job on this branch." \
    >&2
  return 1
}

stop_incomplete_deployment() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [ "$exit_code" -ne 0 ] &&
    [ -n "$job_id" ] &&
    [ "$deployment_terminal" != "true" ]; then
    echo \
      "Handling incomplete Amplify deployment: branch=${branch_name}, job=${job_id}, original_exit=${exit_code}" \
      >&2
    if ! stop_and_confirm_terminal; then
      exit "$AMPLIFY_CANCELLATION_UNCONFIRMED_EXIT_CODE"
    fi
  fi
  exit "$exit_code"
}

trap stop_incomplete_deployment EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! [[ "$app_id" =~ ^d[a-z0-9]+$ ]]; then
  echo "Amplify app ID must match d[a-z0-9]+." >&2
  exit 64
fi
if [ -z "$branch_name" ]; then
  echo "Amplify branch name must not be empty." >&2
  exit 64
fi
if [ ! -f "$archive" ]; then
  echo "Amplify static archive does not exist: $archive" >&2
  exit 66
fi
if ! [[ "$poll_seconds" =~ ^[1-9][0-9]*$ ]] ||
  ! [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] ||
  ! [[ "$stop_attempts" =~ ^[1-9][0-9]*$ ]] ||
  ! [[ "$cancel_polls_per_attempt" =~ ^[1-9][0-9]*$ ]] ||
  ! [[ "$cancel_poll_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "Amplify polling, timeout, and cancellation values must be positive integers." >&2
  exit 64
fi

unzip -tq "$archive" >/dev/null

deployment="$(
  aws amplify create-deployment \
    --app-id "$app_id" \
    --branch-name "$branch_name" \
    --output json
)"
job_id="$(jq -er '.jobId' <<<"$deployment")"
upload_url="$(jq -er '.zipUploadUrl' <<<"$deployment")"
persist_evidence "job_id" "$job_id"
echo "Created Amplify deployment: branch=${branch_name}, job=${job_id}"

# The presigned URL is intentionally never printed or persisted.
curl \
  --fail \
  --silent \
  --show-error \
  --retry 5 \
  --retry-all-errors \
  --retry-delay 2 \
  --request PUT \
  --header "Content-Type: application/zip" \
  --upload-file "$archive" \
  "$upload_url"

aws amplify start-deployment \
  --app-id "$app_id" \
  --branch-name "$branch_name" \
  --job-id "$job_id" \
  >/dev/null

deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
  status="$(
    aws amplify get-job \
      --app-id "$app_id" \
      --branch-name "$branch_name" \
      --job-id "$job_id" \
      --query "job.summary.status" \
      --output text
  )"
  case "$status" in
    SUCCEED)
      deployment_terminal=true
      persist_evidence "status" "$status"
      persist_evidence "terminal_confirmed" "true"
      persist_evidence "cancellation_confirmed" "false"
      echo "Amplify deployment succeeded: branch=${branch_name}, job=${job_id}"
      exit 0
      ;;
    FAILED | CANCELLED)
      deployment_terminal=true
      persist_evidence "status" "$status"
      persist_evidence "terminal_confirmed" "true"
      persist_evidence "cancellation_confirmed" "$(
        if [ "$status" = "CANCELLED" ]; then printf true; else printf false; fi
      )"
      echo "Amplify deployment failed: branch=${branch_name}, job=${job_id}, status=${status}" >&2
      exit 1
      ;;
    CREATED | PENDING | PROVISIONING | RUNNING | CANCELLING)
      sleep "$poll_seconds"
      ;;
    *)
      echo "Unexpected Amplify deployment status: ${status:-empty}" >&2
      exit 1
      ;;
  esac
done

echo "Timed out waiting for Amplify deployment: branch=${branch_name}, job=${job_id}" >&2
exit 1
