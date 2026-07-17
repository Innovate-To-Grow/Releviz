#!/usr/bin/env bash
set -euo pipefail

umask 077

mode="${1:-}"
target_task_definition="${2:-${TARGET_TASK_DEFINITION:-}}"

usage() {
  cat >&2 <<'EOF'
Usage:
  ALLOW_ECS_DEPLOY=1 ECS_CLUSTER=<cluster> ECS_SERVICE=<service> \
    ecs-service-rollout.sh deploy <task-definition>

  ALLOW_ECS_ROLLBACK=1 EXPECTED_CURRENT_TASK_DEFINITION=<current-arn> \
    ECS_CLUSTER=<cluster> ECS_SERVICE=<service> \
    ecs-service-rollout.sh rollback <previous-task-definition>
EOF
}

if [ "$mode" != "deploy" ] && [ "$mode" != "rollback" ]; then
  usage
  exit 2
fi
if [ -z "$target_task_definition" ]; then
  usage
  exit 2
fi

: "${ECS_CLUSTER:?ECS_CLUSTER must be set.}"
: "${ECS_SERVICE:?ECS_SERVICE must be set.}"

aws_region="${AWS_REGION:-us-west-2}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
artifact_dir="${ROLLOUT_ARTIFACT_DIR:-$root_dir/.artifacts/ecs-rollouts/${timestamp}-${mode}}"
before_path="$artifact_dir/before.json"
update_path="$artifact_dir/update.json"
after_path="$artifact_dir/after.json"
evidence_path="$artifact_dir/evidence.json"

if [ "$mode" = "deploy" ] && [ "${ALLOW_ECS_DEPLOY:-0}" != "1" ]; then
  echo "Set ALLOW_ECS_DEPLOY=1 to authorize an ECS deployment." >&2
  exit 2
fi
if [ "$mode" = "rollback" ]; then
  if [ "${ALLOW_ECS_ROLLBACK:-0}" != "1" ]; then
    echo "Set ALLOW_ECS_ROLLBACK=1 to authorize an ECS rollback." >&2
    exit 2
  fi
  : "${EXPECTED_CURRENT_TASK_DEFINITION:?Rollback requires EXPECTED_CURRENT_TASK_DEFINITION.}"
fi

mkdir -p "$artifact_dir"

target_arn="$(
  aws ecs describe-task-definition \
    --region "$aws_region" \
    --task-definition "$target_task_definition" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text
)"
target_status="$(
  aws ecs describe-task-definition \
    --region "$aws_region" \
    --task-definition "$target_task_definition" \
    --query 'taskDefinition.status' \
    --output text
)"
if [ -z "$target_arn" ] || [ "$target_arn" = "None" ] || [ "$target_status" != "ACTIVE" ]; then
  echo "Target task definition must exist and be ACTIVE." >&2
  exit 2
fi

aws ecs describe-services \
  --region "$aws_region" \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" >"$before_path"

current_task_definition="$(
  python3 - "$before_path" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if payload.get("failures"):
    raise SystemExit("ECS describe-services returned a failure.")
services = payload.get("services", [])
if len(services) != 1 or not services[0].get("taskDefinition"):
    raise SystemExit("Expected exactly one ECS service with a task definition.")
print(services[0]["taskDefinition"])
PY
)"

if [ "$mode" = "rollback" ] && [ "$current_task_definition" != "$EXPECTED_CURRENT_TASK_DEFINITION" ]; then
  echo "Refusing rollback because the service revision changed after approval." >&2
  exit 2
fi
if [ "$current_task_definition" = "$target_arn" ]; then
  echo "Target task definition is already active; no rollout was performed." >&2
  exit 2
fi

aws ecs update-service \
  --region "$aws_region" \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$target_arn" \
  --force-new-deployment \
  --deployment-configuration \
  "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" \
  >"$update_path"

aws ecs wait services-stable \
  --region "$aws_region" \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE"

aws ecs describe-services \
  --region "$aws_region" \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" >"$after_path"

python3 - \
  "$mode" \
  "$current_task_definition" \
  "$target_arn" \
  "$before_path" \
  "$update_path" \
  "$after_path" \
  "$evidence_path" <<'PY'
import json
import pathlib
import sys
from datetime import UTC, datetime

(
    mode,
    previous_task_definition,
    target_task_definition,
    before_path,
    update_path,
    after_path,
    evidence_path,
) = sys.argv[1:]
after = json.loads(pathlib.Path(after_path).read_text(encoding="utf-8"))
services = after.get("services", [])
if after.get("failures") or len(services) != 1:
    raise SystemExit("Final ECS service inspection failed.")
service = services[0]
primary = next(
    (deployment for deployment in service.get("deployments", []) if deployment.get("status") == "PRIMARY"),
    None,
)
if service.get("taskDefinition") != target_task_definition:
    raise SystemExit("ECS service did not retain the requested task definition.")
if service.get("runningCount", 0) < service.get("desiredCount", 0):
    raise SystemExit("ECS service has fewer running tasks than desired.")
if primary is None or primary.get("rolloutState") != "COMPLETED":
    raise SystemExit("ECS primary deployment did not complete.")

evidence = {
    "schemaVersion": 1,
    "completedAt": datetime.now(UTC).isoformat(),
    "status": "passed",
    "mode": mode,
    "previousTaskDefinition": previous_task_definition,
    "targetTaskDefinition": target_task_definition,
    "desiredCount": service.get("desiredCount"),
    "runningCount": service.get("runningCount"),
    "rolloutState": primary.get("rolloutState"),
    "artifacts": {
        "before": pathlib.Path(before_path).name,
        "update": pathlib.Path(update_path).name,
        "after": pathlib.Path(after_path).name,
    },
}
pathlib.Path(evidence_path).write_text(
    json.dumps(evidence, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

echo "ECS $mode passed."
echo "Previous task definition: $current_task_definition"
echo "Target task definition: $target_arn"
echo "Evidence: $evidence_path"
