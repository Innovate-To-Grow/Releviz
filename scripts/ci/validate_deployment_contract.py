#!/usr/bin/env python3
"""Keep runtime requirements, Terraform, and deployment workflows aligned."""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PRODUCTION_SETTINGS = ROOT / "src/backend/config/settings/production.py"
BOOTSTRAP_TERRAFORM = ROOT / "infra/bootstrap/main.tf"
TERRAFORM_ENVIRONMENTS = {
    "production": ROOT / "infra/prod/main.tf",
}
PRODUCTION_DEPLOY_WORKFLOW = ROOT / ".github/workflows/deploy-prod.yml"
AMPLIFY_DEPLOY_SCRIPT = ROOT / "scripts/deploy/amplify-static-deploy.sh"
RETIRED_STAGING_PATHS = (
    ".github/workflows/deploy-staging.yml",
    ".github/workflows/retire-staging.yml",
    "infra/staging",
)
REQUIRED_CSV_ENVIRONMENT = {
    "DJANGO_ALLOWED_HOSTS",
    "CORS_ALLOWED_ORIGINS",
    "CSRF_TRUSTED_ORIGINS",
}
ENVIRONMENT_NAME_RE = re.compile(r"\{\s*name\s*=\s*\"([A-Z][A-Z0-9_]*)\"", re.MULTILINE)


def required_runtime_environment(source: str) -> set[str]:
    """Return settings that production treats as deployment requirements."""

    tree = ast.parse(source)
    required = set(REQUIRED_CSV_ENVIRONMENT)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        if not isinstance(node.func, ast.Name) or node.func.id != "required_env":
            continue
        value = node.args[0]
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            required.add(value.value)
    return required


def terraform_environment_names(source: str) -> set[str]:
    """Extract explicitly provisioned container environment and secret names."""

    return set(ENVIRONMENT_NAME_RE.findall(source))


def production_cd_errors(root: Path = ROOT) -> list[str]:
    """Ensure production CD is explicit, protected, immutable, and health-gated."""

    errors: list[str] = []
    active_path = root / PRODUCTION_DEPLOY_WORKFLOW.relative_to(ROOT)
    if not active_path.exists():
        errors.append("production CD workflow is missing")
        return errors

    source = active_path.read_text(encoding="utf-8")
    required_patterns = {
        r"workflow_dispatch:": "manual dispatch",
        r"id-token:\s*write": "OIDC permission",
        r"CONFIRMATION.*DEPLOY|CONFIRMATION\"\s*!=\s*\"DEPLOY\"": "explicit confirmation",
        r"git rev-parse HEAD": "exact checked-out release verification",
        r"CI Result": "successful CI enforcement",
        r"backend_image_tag.*DEPLOY_SHA": "immutable backend release tag",
        r"describe-task-definition": "deployed ECS frontend rollback discovery",
        r"frontend_image_tag.*rollback_sha": "preserved ECS frontend rollback tag",
        r"npm ci --workspace=releviz-frontend": "locked frontend dependency install",
        r"run build:amplify": "Amplify static frontend build",
        r"validate_amplify_static_export\.py": (
            "Amplify static route and asset validation"
        ),
        r"src/frontend/out": "static export artifact",
        r"AMPLIFY_ARTIFACT.*\.sha256": "a retained static-artifact checksum",
        r"release\.json": "immutable frontend release identity",
        r"release_sha.*DEPLOY_SHA": "deployed frontend SHA verification",
        r"amplify-static-deploy\.sh": "manual Amplify deployment helper",
        r"Capture current Amplify production rollback point": (
            "a live Amplify rollback point"
        ),
        r"Roll back production Amplify branch after failed release": (
            "automatic rollback after any failed live release stage"
        ),
        (
            r"steps\.production_deploy\.outputs\.terminal_confirmed\s*==\s*'true'"
        ): "a confirmed-terminal current job before Amplify rollback",
        r"--job-type RETRY": "an Amplify retry rollback",
        r"Smoke candidate Amplify frontend and same-origin proxy": (
            "candidate same-origin proxy smoke tests"
        ),
        r"\.static_routes\[\]": "all exported candidate routes in smoke tests",
        r"\.legacy_redirects \| keys\[\]": (
            "legacy Amplify redirects in candidate smoke tests"
        ),
        r"event/\?code=AMPLIFYSMOKE": (
            "query-preserving trailing-slash route verification"
        ),
        r"src/frontend/out/_next/static": "a deployed static-asset smoke test",
        r"csrfmiddlewaretoken": "a real proxied Django admin CSRF POST",
        r"email=amplify-smoke-\$\{DEPLOY_SHA\}@example\.invalid": (
            "the custom admin email field in the CSRF smoke"
        ),
        r'admin_post_status" != "400"': (
            "the custom admin invalid-login response contract"
        ),
        r"Please enter valid staff account credentials\.": (
            "the proxied admin form-error response"
        ),
        r"PUT /authn/profile": "a proxied protected PUT smoke test",
        r"DELETE /authn/sessions": "a proxied protected DELETE smoke test",
        r"amplify_default_domain": "Amplify default-domain verification",
        r"terraform .* state list": "existing domain cutover state detection",
        r"TF_VAR_amplify_app_id.*PROD_AMPLIFY_APP_ID": (
            "an explicitly provisioned Amplify app ID"
        ),
        (
            r"amplify get-domain-association[\s\S]{0,700}"
            r"terraform -chdir=infra/prod import[\s\S]{0,300}"
            r"aws_amplify_domain_association\.frontend\[0\]"
        ): "orphan Amplify domain-association recovery",
        r"\$\{app_id\}/\$\{domain_name\}": (
            "the documented Amplify domain-association import identity"
        ),
        r"Recovered the existing Amplify domain association into Terraform state": (
            "explicit orphan-recovery evidence"
        ),
        r"origin_restricted_to_cloudfront": "existing origin restriction detection",
        r"trust_cloudfront_proxy_chain": "existing trusted proxy-chain detection",
        r"Capture pre-release canonical Route53 alias": (
            "an exact pre-cutover canonical alias capture"
        ),
        r"Guard live Amplify configuration before candidate smoke": (
            "a pre-candidate guard for live Amplify configuration"
        ),
        r"terraform -chdir=infra/prod show -json production-base\.tfplan": (
            "machine-readable review of the exact base plan"
        ),
        (
            r'address == "aws_amplify_app\.frontend"[\s\S]{0,250}'
            r'address == "aws_amplify_branch\.production"[\s\S]{0,250}'
            r'address == "aws_amplify_domain_association\.frontend\[0\]"'
        ): "live app, production-branch, and domain configuration detection",
        (
            r"DOMAIN_PREEXISTING[\s\S]{0,300}CANONICAL_ROUTES_TO_ALB|"
            r"CANONICAL_ROUTES_TO_ALB[\s\S]{0,300}DOMAIN_PREEXISTING"
        ): ("live-only Amplify configuration gating"),
        r"Move the canonical alias to the documented ECS fallback": (
            "fail-closed guidance for live Amplify configuration changes"
        ),
        r"list-resource-record-sets": "authoritative Route53 alias inspection",
        r"AliasTarget": "Route53 alias-target validation",
        r"routes_to_alb": "migration-fallback DNS state detection",
        r"\$\{alias_target#dualstack\.\}": "dualstack ALB alias normalization",
        r"neither the managed ALB fallback nor Amplify's exact reported apex target": (
            "fail-closed pre-release canonical target validation"
        ),
        r"An ALB canonical alias requires public ingress and one-hop proxy trust": (
            "fallback DNS and ingress/proxy consistency validation"
        ),
        r"Verify preserved canonical alias immediately before cutover": (
            "a pre-cutover DNS race guard"
        ),
        r"refusing cutover": "a fail-closed pre-cutover DNS race guard",
        r"TF_VAR_enable_amplify_domain.*domain_state\.outputs\.preexisting": (
            "non-destructive initial domain state"
        ),
        r"TF_VAR_restrict_origin_to_cloudfront.*origin_state\.outputs\.preexisting": (
            "non-destructive initial origin restriction state"
        ),
        r"TF_VAR_trust_cloudfront_proxy_chain.*proxy_state\.outputs\.preexisting": (
            "non-destructive initial trusted proxy-chain state"
        ),
        r'TF_VAR_enable_amplify_domain:\s*"true"': "reviewed Amplify domain association",
        r'TF_VAR_restrict_origin_to_cloudfront:\s*"true"': (
            "reviewed CloudFront-only origin hardening"
        ),
        r"Wait for Amplify custom domain availability": "custom-domain readiness gate",
        r"Reconcile Amplify domain association for a migration retry": (
            "an existing-association migration retry"
        ),
        r"amplify update-domain-association": (
            "managed Route53 reconciliation on a migration retry"
        ),
        r"Verify Amplify canonical DNS cutover": (
            "authoritative Amplify DNS cutover verification"
        ),
        r"expected_amplify_target": "the service-reported exact Amplify DNS target",
        r"canonical alias did not match Amplify's exact apex DNS target": (
            "fail-closed canonical target verification"
        ),
        r"Fail closed when an Amplify release job is active": (
            "a stale Amplify job preflight"
        ),
        (
            r'for branch in "\$CANDIDATE_BRANCH" "\$PRODUCTION_BRANCH"'
        ): "candidate and production branch job preflights",
        (
            r'"CREATED"[\s\S]*"PENDING"[\s\S]*"PROVISIONING"'
            r'[\s\S]*"RUNNING"[\s\S]*"CANCELLING"'
        ): "all non-terminal Amplify job-state guards",
        r"describe-target-health": "backend ALB target-health verification",
        r"Run canonical production smoke tests": "post-cutover smoke tests",
        r"Allow legacy Route53 alias caches to expire": "a DNS cache drain before hardening",
        r"Verify production through the CloudFront-only origin": (
            "post-origin-restriction smoke tests"
        ),
        r"Plan trusted CloudFront proxy chain": "a separate trusted-proxy rollout",
        r"Wait for trusted-proxy backend rollout": "a trusted-proxy ECS stability gate",
        r"Verify trusted-proxy backend target health": (
            "trusted-proxy backend health verification"
        ),
        r"Verify production through the trusted CloudFront proxy chain": (
            "post-trusted-proxy smoke tests"
        ),
        r"Restore pre-release origin safety state after failure": (
            "automatic infrastructure state restoration"
        ),
        r"production-restore-origin\.tfplan": "an exact infrastructure restoration plan",
        r"Restore pre-release canonical Route53 alias after failed first cutover": (
            "automatic first-cutover DNS compensation"
        ),
        r"restore_origin_safety\.outcome == 'success'": (
            "origin safety restoration before DNS compensation"
        ),
        r"route53 change-resource-record-sets": "an atomic Route53 alias restoration",
        r'Action:\s*"UPSERT"': "a non-destructive canonical alias UPSERT",
        r"route53 wait resource-record-sets-changed": (
            "authoritative DNS change propagation"
        ),
        r"AMPLIFY_ALIAS_FILE": "a captured post-cutover alias race guard",
        r"\.dnsRecord": "service-reported Amplify alias verification during compensation",
        r"refusing to overwrite it": "fail-closed DNS compensation on manual drift",
        (
            r"apex_alias\.outputs\.routes_to_alb != 'true'[\s\S]{0,300}"
            r"Roll back production Amplify branch|"
            r"Roll back production Amplify branch[\s\S]{0,300}"
            r"apex_alias\.outputs\.routes_to_alb != 'true'"
        ): "later-release-only Amplify branch rollback",
    }
    for pattern, description in required_patterns.items():
        if not re.search(pattern, source, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description}")
    if source.count("jq -r '.static_routes[]'") < 2:
        errors.append(
            "production CD omits all exported routes from candidate or production branch smokes"
        )
    if source.count("find src/frontend/out/_next/static") < 2:
        errors.append(
            "production CD omits a deployed static asset from candidate or production branch smokes"
        )

    forbidden_patterns = {
        r"TF_VAR_manage_dns": "legacy DNS-disable cutover flow",
        r"docker build[\s\S]{0,300}src/frontend": "a production frontend Docker build",
        r"amplify [^\n]*(?:--repository|access-token)": (
            "a Git repository or access-token connection"
        ),
        r"amplify delete-domain-association": (
            "a destructive automated Amplify domain disassociation"
        ),
    }
    for pattern, description in forbidden_patterns.items():
        if re.search(pattern, source, re.MULTILINE | re.IGNORECASE):
            errors.append(f"production CD retains {description}")

    ordered_markers = (
        "Capture pre-release canonical Route53 alias",
        "Guard live Amplify configuration before candidate smoke",
        "Fail closed when an Amplify release job is active",
        "Capture current Amplify production rollback point",
        "Deploy candidate Amplify branch",
        "Smoke candidate Amplify frontend and same-origin proxy",
        "Deploy production Amplify branch",
        "Smoke production Amplify branch before domain cutover",
        "Verify preserved canonical alias immediately before cutover",
        "Plan reviewed Amplify domain association",
        "Reconcile Amplify domain association for a migration retry",
        "Verify Amplify canonical DNS cutover",
        "Run canonical production smoke tests",
        "Plan CloudFront-only origin hardening",
        "Verify production through the CloudFront-only origin",
        "Plan trusted CloudFront proxy chain",
        "Wait for trusted-proxy backend rollout",
        "Verify production through the trusted CloudFront proxy chain",
        "Restore pre-release origin safety state after failure",
        "Restore pre-release canonical Route53 alias after failed first cutover",
        "Roll back production Amplify branch after failed release",
    )
    positions = [source.find(marker) for marker in ordered_markers]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        errors.append(
            "production CD must verify candidate, production, custom-domain, and "
            "origin-hardening stages in order"
        )
    return errors


def amplify_deploy_script_errors(root: Path = ROOT) -> list[str]:
    """Ensure manual Amplify uploads are started, polled, and fail closed."""

    errors: list[str] = []
    script_path = root / AMPLIFY_DEPLOY_SCRIPT.relative_to(ROOT)
    if not script_path.exists():
        return ["manual Amplify deployment helper is missing"]

    source = script_path.read_text(encoding="utf-8")
    required_patterns = {
        r"amplify create-deployment": "create-deployment call",
        r"--upload-file": "presigned ZIP upload",
        r"amplify start-deployment": "start-deployment call",
        r"amplify get-job": "deployment status polling",
        r"amplify stop-job": "failed or interrupted deployment cancellation",
        r"AMPLIFY_STOP_ATTEMPTS": "bounded cancellation retries",
        r"terminal_confirmed": "persisted terminal-state evidence",
        r"cancellation_confirmed": "persisted cancellation evidence",
        r"GITHUB_OUTPUT": "persisted deployment job evidence",
        r"AMPLIFY_CANCELLATION_UNCONFIRMED_EXIT_CODE": (
            "a distinct unconfirmed-cancellation failure"
        ),
        r"Do not start a retry or rollback job": (
            "an explicit active-job rollback safety warning"
        ),
        r"trap\s+'exit 130'\s+INT": "interrupt cleanup",
        r"trap\s+'exit 143'\s+TERM": "termination cleanup",
        r"SUCCEED": "successful terminal state",
        r"FAILED \| CANCELLED": "failed terminal states",
        r"Timed out waiting": "bounded deployment timeout",
    }
    for pattern, description in required_patterns.items():
        if not re.search(pattern, source):
            errors.append(f"manual Amplify deployment helper omits {description}")
    return errors


def deployment_contract_errors(root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    settings_path = root / PRODUCTION_SETTINGS.relative_to(ROOT)
    required = required_runtime_environment(settings_path.read_text(encoding="utf-8"))

    for environment, path in TERRAFORM_ENVIRONMENTS.items():
        candidate = root / path.relative_to(ROOT)
        provided = terraform_environment_names(candidate.read_text(encoding="utf-8"))
        missing = sorted(required - provided)
        if missing:
            errors.append(
                f"{environment} Terraform omits runtime settings: {', '.join(missing)}"
            )

    errors.extend(production_cd_errors(root))
    errors.extend(amplify_deploy_script_errors(root))

    for relative_path in RETIRED_STAGING_PATHS:
        candidate = root / relative_path
        exists = candidate.is_file() or (
            candidate.is_dir()
            and any(
                ".terraform" not in path.relative_to(candidate).parts
                for path in candidate.rglob("*")
            )
        )
        if exists:
            errors.append(f"retired staging path remains: {relative_path}")

    production_terraform = (
        root / TERRAFORM_ENVIRONMENTS["production"].relative_to(ROOT)
    ).read_text(encoding="utf-8")
    production_invariants = {
        r'resource\s+"aws_ecs_service"\s+"backend"': "a backend ECS service",
        r'resource\s+"aws_ecs_service"\s+"frontend"': "a frontend ECS rollback service",
        r"assign_public_ip\s*=\s*false": "private ECS networking",
        r"multi_az\s*=\s*true": "Multi-AZ PostgreSQL",
        r"manage_master_user_password\s*=\s*true": "an RDS-managed database password",
        r"deployment_circuit_breaker\s*\{": "ECS automatic rollback",
        r"alarm_actions\s*=\s*var\.alarm_action_arns": "monitored alarm actions",
        r'resource\s+"aws_amplify_app"\s+"frontend"': "an Amplify frontend app",
        r'platform\s*=\s*"WEB"': "static Amplify hosting",
        r'resource\s+"aws_amplify_branch"\s+"candidate"': "an Amplify candidate branch",
        r'resource\s+"aws_amplify_branch"\s+"production"': (
            "an Amplify production branch"
        ),
        r'resource\s+"aws_amplify_domain_association"\s+"frontend"': (
            "an Amplify custom-domain association"
        ),
        r"count\s*=\s*var\.enable_amplify_domain\s*\?\s*1\s*:\s*0": (
            "health-gated Amplify domain cutover"
        ),
        (
            r"removed\s*\{[\s\S]*from\s*=\s*aws_route53_record\.app"
            r"[\s\S]*destroy\s*=\s*false"
        ): "non-destructive legacy apex-record state removal",
        r"com\.amazonaws\.global\.cloudfront\.origin-facing": (
            "the AWS-managed CloudFront origin prefix list"
        ),
        r"var\.restrict_origin_to_cloudfront": "a gated CloudFront-only origin",
        r"var\.trust_cloudfront_proxy_chain": "a separately gated trusted proxy chain",
        r"AUTH_TRUSTED_PROXY_COUNT": "trusted proxy-chain runtime configuration",
        r"AUTH_TRUSTED_PROXY_CIDRS": "a CloudFront CIDR runtime allowlist",
        r"AUTH_TRUSTED_PROXY_CIDR_HOPS": "CIDR-verified proxy-hop configuration",
        r"cloudfront_origin_facing\.entries": "CloudFront prefix-list CIDR expansion",
        r'xff_header_processing_mode\s*=\s*"append"': "explicit ALB XFF append mode",
        r"enable_xff_client_port\s*=\s*false": "port-free ALB XFF addresses",
        r"amplify-routes\.json": "a shared Amplify static route manifest",
        r'resource\s+"aws_cloudwatch_metric_alarm"\s+"amplify_5xx"': (
            "Amplify hosting 5xx monitoring"
        ),
        (
            r'command\s*=\s*\[\s*"python"\s*,\s*"manage\.py"\s*,'
            r'\s*"send_due_event_reminders"\s*,\s*"--window-minutes=20"\s*\]'
        ): "a runnable scheduled reminder command",
    }
    for pattern, description in production_invariants.items():
        if not re.search(pattern, production_terraform):
            errors.append(f"production Terraform omits {description}")

    bootstrap_terraform = (root / BOOTSTRAP_TERRAFORM.relative_to(ROOT)).read_text(
        encoding="utf-8"
    )
    for pattern, description in {
        r'backend\s+"s3"\s*\{\s*\}': "an S3 backend declaration for migrated bootstrap state",
        r"existing_github_oidc_provider_arn": "an explicit shared GitHub OIDC provider input",
        r"from\s*=\s*aws_iam_openid_connect_provider\.github": "a non-destructive legacy OIDC state removal",
        r"destroy\s*=\s*false": "a shared OIDC provider preservation guard",
    }.items():
        if not re.search(pattern, bootstrap_terraform):
            errors.append(f"bootstrap Terraform omits {description}")
    if re.search(r'resource\s+"aws_iam_openid_connect_provider"', bootstrap_terraform):
        errors.append(
            "bootstrap Terraform must not manage the shared GitHub OIDC provider"
        )

    return errors


def main() -> int:
    errors = deployment_contract_errors()
    if errors:
        print("Deployment contract validation failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("Production CD and Terraform retain their release safety invariants.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
