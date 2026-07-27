#!/usr/bin/env bash

set -euo pipefail

# One-time, administrator-run provisioning for resources whose creation
# permissions must never be granted to the GitHub production deploy role.
# The script is intentionally idempotent and never deletes or retags resources.

aws_region="${AWS_REGION:-us-west-2}"
expected_aws_account_id="${EXPECTED_AWS_ACCOUNT_ID:-}"
app_name="releviz-prod-frontend"
app_description="Releviz production static frontend deployed manually from the protected release workflow"

usage() {
  cat >&2 <<'EOF'
Usage:
  EXPECTED_AWS_ACCOUNT_ID=<12-digit-production-account-id> \
    [AWS_REGION=us-west-2] infra/bootstrap/provision-amplify.sh

The expected account ID is required. The script verifies the active AWS
identity before reading or creating any Amplify resources.
EOF
}

if (( $# > 0 )); then
  if [[ "$#" == "1" && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
    usage
    exit 0
  fi
  usage
  exit 2
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 1
fi

if [[ ! "$expected_aws_account_id" =~ ^[0-9]{12}$ ]]; then
  echo "EXPECTED_AWS_ACCOUNT_ID must be set to the 12-digit production AWS account ID." >&2
  usage
  exit 2
fi

export AWS_PAGER=""

if ! caller_identity="$(
  aws sts get-caller-identity \
    --region "$aws_region" \
    --query '[Account,Arn]' \
    --output text
)"; then
  echo "Unable to verify the active AWS identity; refusing to inspect or modify Amplify." >&2
  exit 1
fi

read -r caller_account_id caller_arn <<<"$caller_identity"
if [[ ! "$caller_account_id" =~ ^[0-9]{12}$ || -z "$caller_arn" || "$caller_arn" == "None" ]]; then
  echo "AWS STS returned an invalid caller identity; refusing to inspect or modify Amplify." >&2
  exit 1
fi
if [[ "$caller_account_id" != "$expected_aws_account_id" ]]; then
  echo "Refusing to provision Amplify in AWS account $caller_account_id; expected production account $expected_aws_account_id." >&2
  exit 1
fi
echo "Verified production AWS account $caller_account_id ($caller_arn)." >&2

verify_owned_tags() {
  local resource_arn="$1"
  local project environment managed_by

  project="$(aws amplify list-tags-for-resource \
    --region "$aws_region" \
    --resource-arn "$resource_arn" \
    --query 'tags.Project' \
    --output text)"
  environment="$(aws amplify list-tags-for-resource \
    --region "$aws_region" \
    --resource-arn "$resource_arn" \
    --query 'tags.Environment' \
    --output text)"
  managed_by="$(aws amplify list-tags-for-resource \
    --region "$aws_region" \
    --resource-arn "$resource_arn" \
    --query 'tags.ManagedBy' \
    --output text)"

  if [[ "$project" != "releviz" || "$environment" != "prod" || "$managed_by" != "terraform" ]]; then
    echo "Refusing to adopt Amplify resource without Project=releviz, Environment=prod, ManagedBy=terraform: $resource_arn" >&2
    exit 1
  fi
}

app_ids="$(
  aws amplify list-apps \
    --region "$aws_region" \
    --query "apps[?name=='${app_name}'].appId" \
    --output text
)"

if [[ -z "$app_ids" || "$app_ids" == "None" ]]; then
  app_id="$(
    aws amplify create-app \
      --region "$aws_region" \
      --name "$app_name" \
      --description "$app_description" \
      --platform WEB \
      --no-enable-auto-branch-creation \
      --no-enable-basic-auth \
      --no-enable-branch-auto-build \
      --no-enable-branch-auto-deletion \
      --cache-config type=AMPLIFY_MANAGED \
      --tags Project=releviz,Environment=prod,ManagedBy=terraform \
      --query 'app.appId' \
      --output text
  )"
  echo "Created Amplify app $app_name ($app_id)." >&2
else
  # AWS CLI text output separates multiple matches with tabs. Refuse an
  # ambiguous name instead of binding production permissions to the wrong app.
  app_count="$(printf '%s\n' "$app_ids" | awk '{ print NF }')"
  if [[ "$app_count" != "1" ]]; then
    echo "Expected zero or one Amplify app named $app_name, found $app_count; resolve the ambiguity manually." >&2
    exit 1
  fi
  app_id="$app_ids"
  echo "Reusing Amplify app $app_name ($app_id)." >&2
fi

app_json="$(
  aws amplify get-app \
    --region "$aws_region" \
    --app-id "$app_id" \
    --query 'app.{arn:appArn,name:name,platform:platform}' \
    --output text
)"
read -r app_arn existing_name existing_platform <<<"$app_json"
if [[ "$existing_name" != "$app_name" || "$existing_platform" != "WEB" ]]; then
  echo "Refusing Amplify app with unexpected identity or platform: $app_id" >&2
  exit 1
fi
verify_owned_tags "$app_arn"

ensure_branch() {
  local branch_name="$1"
  local stage="$2"
  local description="$3"
  local error_file branch_json branch_arn existing_branch existing_stage

  error_file="$(mktemp)"
  if branch_json="$(
    aws amplify get-branch \
      --region "$aws_region" \
      --app-id "$app_id" \
      --branch-name "$branch_name" \
      --query 'branch.{arn:branchArn,name:branchName,stage:stage}' \
      --output text 2>"$error_file"
  )"; then
    :
  elif grep -q "NotFoundException" "$error_file"; then
    branch_json="$(
      aws amplify create-branch \
        --region "$aws_region" \
        --app-id "$app_id" \
        --branch-name "$branch_name" \
        --display-name "$branch_name" \
        --description "$description" \
        --stage "$stage" \
        --framework "Next.js - Static" \
        --no-enable-auto-build \
        --no-enable-basic-auth \
        --no-enable-notification \
        --no-enable-performance-mode \
        --no-enable-pull-request-preview \
        --tags Project=releviz,Environment=prod,ManagedBy=terraform \
        --query 'branch.{arn:branchArn,name:branchName,stage:stage}' \
        --output text
    )"
    echo "Created Amplify branch $branch_name." >&2
  else
    echo "Unable to inspect Amplify branch $branch_name:" >&2
    sed 's/^/  /' "$error_file" >&2
    rm -f "$error_file"
    exit 1
  fi
  rm -f "$error_file"

  read -r branch_arn existing_branch existing_stage <<<"$branch_json"
  if [[ "$existing_branch" != "$branch_name" || "$existing_stage" != "$stage" ]]; then
    echo "Refusing Amplify branch with unexpected name or stage: $branch_arn" >&2
    exit 1
  fi
  verify_owned_tags "$branch_arn"
}

ensure_branch "candidate" "BETA" "Pre-production branch for the exact release artifact"
ensure_branch "main" "PRODUCTION" "Production branch promoted from the smoke-tested candidate artifact"

echo "Provisioning complete. Re-apply infra/bootstrap with production_amplify_app_id=$app_id before running the production workflow." >&2
printf '%s\n' "$app_id"
