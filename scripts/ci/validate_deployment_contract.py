#!/usr/bin/env python3
"""Keep runtime requirements, Terraform, and deployment workflows aligned."""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRODUCTION_SETTINGS = ROOT / "src/api/config/settings/production.py"
BOOTSTRAP_TERRAFORM = ROOT / "infra/bootstrap/main.tf"
TERRAFORM_ENVIRONMENTS = {
    "production": ROOT / "infra/prod/main.tf",
}
# The production release is three workflows (backend, frontend, infrastructure)
# that share two composite actions. Each workflow runs a no-credential scope
# job, then a release job gated by a protected environment: "AWS ECS - Prod"
# (backend, infrastructure) or "AWS Amplify - Prod" (frontend), each with its
# own bootstrap-managed OIDC role.
PRODUCTION_RELEASE_WORKFLOWS = {
    "backend": ROOT / ".github/workflows/release-backend.yml",
    "frontend": ROOT / ".github/workflows/release-frontend.yml",
    "infrastructure": ROOT / ".github/workflows/release-infrastructure.yml",
}
RELEASE_PREFLIGHT_ACTION = ROOT / ".github/actions/release-preflight/action.yml"
RELEASE_SCOPE_ACTION = ROOT / ".github/actions/release-scope/action.yml"
# The single 3,000-line release workflow was retired when releases were split;
# it must not come back beside the split workflows.
RETIRED_RELEASE_WORKFLOWS = (
    ".github/workflows/deploy-prod.yml",
    ".github/workflows/deploy-prod.yml.disabled",
)
PRODUCTION_AMPLIFY_CUSTOM_HEADERS = ROOT / "infra/prod/amplify-custom-headers.json"
AMPLIFY_DEPLOY_SCRIPT = ROOT / "scripts/deploy/amplify-static-deploy.sh"
BACKEND_ENTRYPOINT = ROOT / "src/api/docker-entrypoint.sh"
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
# The release commit: the CI run's head commit for automatic (workflow_run)
# releases, the selected main commit for manual dispatch. github.sha alone is
# the default-branch tip at trigger time, which can already be a newer commit.
RELEASE_SHA_EXPRESSION_RE = (
    r"\$\{\{\s*github\.event_name\s*==\s*'workflow_run'\s*&&\s*"
    r"github\.event\.workflow_run\.head_sha\s*\|\|\s*github\.sha\s*\}\}"
)

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


def production_release_paths(root: Path = ROOT) -> dict[str, Path]:
    """Return the release workflow and shared action files for a checkout."""

    paths = {
        scope: root / path.relative_to(ROOT) for scope, path in PRODUCTION_RELEASE_WORKFLOWS.items()
    }
    paths["preflight"] = root / RELEASE_PREFLIGHT_ACTION.relative_to(ROOT)
    paths["scope-action"] = root / RELEASE_SCOPE_ACTION.relative_to(ROOT)
    return paths


AUTOMATIC_RELEASE_GUARD_RE = (
    r"github\.event\.workflow_run\.conclusion\s*==\s*'success'\s*&&\s*"
    r"github\.event\.workflow_run\.event\s*==\s*'push'\s*&&\s*"
    r"github\.event\.workflow_run\.head_branch\s*==\s*'main'\s*&&\s*"
    r"github\.event\.workflow_run\.head_repository\.full_name\s*==\s*github\.repository"
)

# Invariants every release workflow must keep.
COMMON_RELEASE_WORKFLOW_RULES = {
    (
        r"workflow_run:\s*\n\s*workflows:\s*\[CI\]\s*\n\s*types:\s*\[completed\]"
        r"\s*\n\s*branches:\s*\[main\]"
    ): "automatic release requests from CI runs on main",
    r"workflow_dispatch:": "manual dispatch",
    r"description: Type DEPLOY to release": "the DEPLOY confirmation input",
    AUTOMATIC_RELEASE_GUARD_RE: (
        "an automatic-release guard for successful push CI runs on main from this repository"
    ),
    r"actions:\s*read": "GitHub Actions artifact read permission",
    r"id-token:\s*write": "OIDC permission",
    r"cancel-in-progress:\s*false": "non-cancelling release concurrency",
    r"uses:\s*\./\.github/actions/release-scope": "the no-credential change scope job",
    r"fetch-depth:\s*0": "full history for change scoping",
    r"needs:\s*scope": "a release job gated on the scope job",
    r"if:\s*\$\{\{\s*needs\.scope\.outputs\.release\s*==\s*'true'\s*\}\}": (
        "a release job that only runs when its scope changed"
    ),
    r"TRIGGER_EVENT:\s*\$\{\{\s*github\.event_name\s*\}\}": (
        "the trigger event for the shared preflight"
    ),
    r"CONFIRMATION:\s*\$\{\{\s*inputs\.confirmation\s*\}\}": (
        "the manual confirmation for the shared preflight"
    ),
    r"DEPLOY_SHA:\s*" + RELEASE_SHA_EXPRESSION_RE: "the release commit as the deploy SHA",
    r"ref:\s*\$\{\{\s*env\.DEPLOY_SHA\s*\}\}": "checkout of the exact release commit",
    r"uses:\s*\./\.github/actions/release-preflight": "the shared release preflight",
    r"if:\s*\$\{\{\s*always\(\)\s*\}\}[\s\S]{0,900}GITHUB_STEP_SUMMARY": (
        "an always-written release summary"
    ),
}

# Backend and infrastructure releases run from the "AWS ECS - Prod" environment
# under the production role, which owns Terraform state, ECS, and the
# application secrets' metadata.
ECS_ENVIRONMENT_RULES = {
    r"environment:\s*\n\s*name:\s*AWS ECS - Prod": "the AWS ECS - Prod environment gate",
    r"AWS_ROLE_ARN:\s*\$\{\{\s*vars\.AWS_PROD_ROLE_ARN\s*\}\}": (
        "the production OIDC role from the AWS ECS - Prod environment"
    ),
    (
        r"TF_VAR_default_admin_email:\s*\$\{\{\s*"
        r"vars\.PROD_DEFAULT_ADMIN_EMAIL\s*\|\|\s*'admin@releviz\.com'\s*\}\}|"
        r"DEFAULT_ADMIN_EMAIL:\s*\$\{\{\s*"
        r"vars\.PROD_DEFAULT_ADMIN_EMAIL\s*\|\|\s*'admin@releviz\.com'\s*\}\}"
    ): "the reviewed production default-admin email input",
}

# The frontend release runs from the "AWS Amplify - Prod" environment under the
# frontend-only role; it carries no backend configuration at all.
AMPLIFY_ENVIRONMENT_RULES = {
    r"environment:\s*\n\s*name:\s*AWS Amplify - Prod": "the AWS Amplify - Prod environment gate",
    r"AWS_ROLE_ARN:\s*\$\{\{\s*vars\.AWS_PROD_FRONTEND_ROLE_ARN\s*\}\}": (
        "the frontend-only OIDC role from the AWS Amplify - Prod environment"
    ),
}

# Text a release workflow may not contain because it belongs to the other
# environment.
SCOPED_FORBIDDEN_RELEASE_WORKFLOW_RULES = {
    "backend": {
        r"AWS Amplify - Prod": "the frontend environment",
        r"AWS_PROD_FRONTEND_ROLE_ARN": "the frontend-only role variable",
    },
    "infrastructure": {
        r"AWS Amplify - Prod": "the frontend environment",
        r"AWS_PROD_FRONTEND_ROLE_ARN": "the frontend-only role variable",
    },
    "frontend": {
        r"AWS ECS - Prod": "the backend environment",
        r"AWS_PROD_ROLE_ARN": "the production role variable AWS_PROD_ROLE_ARN",
        r"PROD_TF_STATE_BUCKET": "the Terraform state bucket",
        r"PROD_DJANGO_SECRET_KEY_ARN|PROD_DJANGO_FIELD_ENCRYPTION_KEY_ARN": (
            "application secret ARNs"
        ),
        r"PROD_METRICS_BEARER_TOKEN_ARN|PROD_SENTRY_DSN_SECRET_ARN": "monitoring secret ARNs",
        r"PROD_DEFAULT_ADMIN_EMAIL|PROD_DEFAULT_ADMIN_PASSWORD_SECRET_ARN": (
            "default-admin bootstrap inputs"
        ),
        r"PROD_ALARM_ACTION_ARNS_JSON": "alarm actions",
        r"TF_VAR_": "Terraform inputs",
    },
}

# Text no release workflow may contain.
FORBIDDEN_RELEASE_WORKFLOW_RULES = {
    r"\$\{\{\s*secrets\.": "GitHub secrets (production secrets live in AWS Secrets Manager)",
    r"TF_VAR_manage_dns": "legacy DNS-disable cutover flow",
    r"restrict_origin_to_cloudfront|trust_cloudfront_proxy_chain": (
        "retired CloudFront origin inputs"
    ),
    r"start-job\s+--job-type\s+RETRY": "unsupported Amplify StartJob retry rollback",
    r"aws-access-key-id|aws-secret-access-key": "static AWS keys",
}

TERRAFORM_STEADY_STATE_RULES = {
    r'TF_VAR_enable_amplify_domain:\s*"true"': "the completed Amplify domain association",
    r'TF_VAR_enable_legacy_api_compatibility:\s*"false"': "the completed API-subdomain topology",
    r"-lock-timeout=15m": "a bounded wait for the remote state lock",
    r"apply -input=false -auto-approve [a-z]+-release\.tfplan": "an exact saved-plan apply",
    r"show -json [a-z]+-release\.tfplan": "a machine-readable plan review",
    r'\.change\.actions == \["delete"\]': "a no-destroy plan guard",
    r"aws ecs wait services-stable": "ECS service stabilization",
    r"for role in backend result_worker email_worker frontend": (
        "verification of the backend, both durable workers, and the fallback frontend"
    ),
    r'"\$\{role\}_task_definition_arn"': "Terraform-selected ECS task definitions",
    r"\.services\[0\]\.taskDefinition\s*==\s*\$expected": ("ECS service task-definition identity"),
    r"EcsParameters\.TaskDefinitionArn\s*==\s*\$expected": (
        "the reminder schedule pinned to the released backend task definition"
    ),
    r"describe-target-health": "ALB target health verification",
    r"for path in /health/live /health /admin/": "API health smoke",
    r"Access-Control-Request-Method: PUT": "a credentialed CORS preflight smoke",
}

SCOPED_RELEASE_WORKFLOW_RULES = {
    "backend": {
        **ECS_ENVIRONMENT_RULES,
        **TERRAFORM_STEADY_STATE_RULES,
        r"TF_VAR_backend_image_tag:\s*" + RELEASE_SHA_EXPRESSION_RE: (
            "the release commit as the backend image tag"
        ),
        r"--image-tag-mutability IMMUTABLE": "an immutable ECR repository",
        r"scanOnPush=true": "ECR image scanning",
        r"describe-images[\s\S]{0,120}imageTag=\$\{DEPLOY_SHA\}": (
            "an existing-image short circuit"
        ),
        r'docker build --pull --tag "\$image_uri" \./src/api': "the backend image build",
        r"workflows/release-frontend\.yml/runs\?branch=main&status=success": (
            "the fallback frontend held at the latest successful frontend release"
        ),
        r"TF_VAR_frontend_image_tag:\s*\$\{\{\s*steps\.frontend_tag\.outputs\.sha\s*\}\}": (
            "the resolved fallback frontend tag in the plan"
        ),
        r"Detect live Amplify not-found routing": "live Amplify not-found routing detection",
        (
            r"Plan the backend release[\s\S]{0,400}"
            r"TF_VAR_enable_amplify_not_found_rule:\s*\$\{\{\s*"
            r"steps\.not_found_rule\.outputs\.live\s*\}\}"
            r"[\s\S]{0,400}backend-release\.tfplan"
        ): "the live Amplify not-found state in the backend plan",
        r"-out=backend-release\.tfplan": "a saved backend plan",
        (
            r"aws_\(ecs_task_definition\|ecs_service\|appautoscaling_\(target\|policy\)"
            r"\|cloudwatch_\(metric_alarm\|log_group\|log_metric_filter\|event_rule\|event_target\)\)"
        ): "a runtime-only backend plan guard",
        r"Release those changes through the infrastructure workflow first": (
            "a redirect of non-runtime changes to the infrastructure release"
        ),
        (
            r'"recompute_event_results","--watch","--poll-interval=1"'
        ): "the exact result-worker command",
        (
            r'"dispatch_email_jobs","--watch","--limit=1000","--concurrency=10",'
            r'"--rate-limit=10","--poll-interval=1"'
        ): "the exact email-worker command",
        r"stopTimeout == 120": "graceful worker shutdown",
        r"healthCheck\.retries == 3": "worker container health checks",
        r'"DJANGO_MIGRATE_ON_START" and \.value == "1"': "worker-owned locked migrations",
        r"Ensure production default administrator through one-off ECS task": (
            "the dedicated default-admin one-off task"
        ),
        r'\["python", "manage\.py", "ensure_default_admin", "--yes", "--create-only"\]': (
            "a create-only default-admin command"
        ),
        r'\(\.taskDefinition\.taskRoleArn // ""\) == ""': "a default-admin task without a task role",
        r'"DJANGO_SUPERUSER_PASSWORD"\s*\n\s*and \.valueFrom == \$password_secret': (
            "the default-admin JSON password-key selector"
        ),
        r"\$\{TF_VAR_default_admin_password_secret_arn\}:password::": (
            "the default-admin password secret field"
        ),
        r"\.name != \"DJANGO_SUPERUSER_PASSWORD\"": (
            "a backend service without administrator bootstrap inputs"
        ),
        r'--started-by "\$started_by"': "a unique default-admin started-by token",
        r"key=Purpose,value=default-admin-bootstrap": "tagged default-admin tasks",
        r"timeout --signal=TERM 900s": "a bounded default-admin wait",
        r'\.stopCode == "EssentialContainerExited"': "stopped-task verification",
        r"\.exitCode == 0": "successful container exit verification",
        r"Clean up an interrupted default-administrator task": (
            "compensating cleanup of interrupted default-admin tasks"
        ),
        r"aws ecs stop-task": "a compensating stop of interrupted default-admin tasks",
        r"timeout --signal=TERM 180s": "bounded verification of compensating cleanup",
        r"for path in /api/health /api/health/live": "retired legacy route verification",
        r'\[ "\$status" != "404" \]': "retired routes returning 404",
    },
    "frontend": {
        **AMPLIFY_ENVIRONMENT_RULES,
        r'AMPLIFY_TIMEOUT_SECONDS:\s*"1200"': "the bounded Amplify deployment-helper timeout",
        r"AMPLIFY_ARTIFACT:.*releviz-amplify-" + RELEASE_SHA_EXPRESSION_RE + r"\.zip": (
            "a SHA-identified Amplify artifact"
        ),
        r"CANDIDATE_BRANCH:\s*candidate": "the Amplify candidate branch",
        r"PRODUCTION_BRANCH:\s*main": "the Amplify production branch",
        r"aws amplify update-app[\s\S]{0,120}--custom-headers": (
            "installation of the reviewed Amplify security headers"
        ),
        r'grep -Fq "https://\$\{API_DOMAIN\}" <<<"\$live_headers"': (
            "verification of the retained API connect-src policy"
        ),
        r"get-domain-association": "the live Amplify domain check",
        r'\.domainAssociation\.domainStatus == "AVAILABLE"': "an available Amplify domain",
        r"amplify-apex-target\.sh": "the Amplify apex target helper",
        r"list-resource-record-sets": "the canonical alias check",
        r"Detect live Amplify not-found routing": "live Amplify not-found routing detection",
        r"NOT_FOUND_RULE_LIVE:\s*\$\{\{\s*steps\.not_found_rule\.outputs\.live\s*\}\}": (
            "smoke tests keyed to the live Amplify not-found state"
        ),
        r"\$\{candidate_url\}/releviz-smoke-missing-\$\{DEPLOY_SHA\}/": (
            "candidate unknown-path 404 smoke"
        ),
        r"https://\$\{PROD_DOMAIN\}/releviz-smoke-missing-\$\{DEPLOY_SHA\}/\?missing_check=": (
            "canonical unknown-path 404 smoke"
        ),
        r'grep -Fq "Page not found"': "the exported Next 404 document in unknown-path smoke",
        r"Fail closed when an Amplify release job is active": "an active-job fail-closed gate",
        r'--build-arg "NEXT_PUBLIC_API_BASE_URL=https://\$\{API_DOMAIN\}"': (
            "the API subdomain baked into the ECS frontend fallback"
        ),
        r"\./src/web\s*\n\s*docker push": "an API-aware ECS frontend fallback build",
        r"run build:amplify": "the Amplify static build",
        r"validate_amplify_static_export\.py": "static export validation",
        r"jq -n --arg sha \"\$DEPLOY_SHA\" '\{sha: \$sha\}' >src/web/out/release\.json": (
            "a release identity in the artifact"
        ),
        r"unzip -tq \"\$AMPLIFY_ARTIFACT\"": "artifact integrity verification",
        r"sha256sum \"\$artifact_name\"": "an artifact checksum",
        r"retention-days:\s*90": "90-day rollback artifact retention",
        r"if-no-files-found:\s*error": "a required rollback artifact upload",
        r"Capture current Amplify production rollback point": "a captured rollback point",
        r"gh api[\s\S]{0,100}--method\s+GET": "an explicit read-only artifact API request",
        r"--paginate[\s\S]{0,100}--slurp": "complete paginated rollback artifact discovery",
        r"\.name\s*==\s*\$name": "exact rollback artifact-name matching",
        r"\.expired\s*==\s*false": "an unexpired rollback-artifact requirement",
        r"\.workflow_run\.head_sha\s*==\s*\$sha": "rollback artifact head-SHA binding",
        r"\.head_branch\s*==\s*\"main\"": "rollback artifact main-branch binding",
        (
            r"\.path == \"\.github/workflows/release-frontend\.yml\"\s*\n\s*"
            r"or \.path == \"\.github/workflows/deploy-prod\.yml\""
        ): "rollback artifact production-workflow binding",
        r"\(\.event == \"workflow_dispatch\" or \.event == \"workflow_run\"\)": (
            "rollback artifact release-event binding"
        ),
        r"\.status\s*==\s*\"completed\"": "a completed trusted rollback workflow run",
        r"\.head_repository\.full_name == \$repository": "rollback artifact repository binding",
        r"digest-mismatch:\s*error": "rollback artifact digest verification",
        r"sha256sum --check --strict": "rollback artifact checksum verification",
        r"\(\^/\|\(\^\|/\)\\\.\\\.\(/\|\$\)\|\\\\\)": "rollback ZIP path-safety verification",
        r"grep -cx 'release\.json'": "a single rollback release identity",
        r"Deploy candidate Amplify branch": "a candidate deployment",
        r"Smoke candidate Amplify frontend and direct API boundary": "candidate smoke tests",
        r"strict-transport-security: max-age=31536000; includeSubDomains": "HSTS verification",
        r"connect-src 'self' https://\$\{API_DOMAIN\}": "CSP connect-src verification",
        r"jq -r '\.static_routes\[\]' src/web/amplify-routes\.json": "static route smoke",
        r"jq -r '\.legacy_redirects \| keys\[\]' src/web/amplify-routes\.json": (
            "legacy redirect smoke"
        ),
        r"/event/\?code=AMPLIFYSMOKE": "query-preserving redirect smoke",
        r"_next/static -type f -name '\*\.js'": "deployed JavaScript smoke",
        r"Access-Control-Request-Method: PUT": "a credentialed CORS preflight smoke",
        r"/authn/refresh/": "a protected refresh smoke",
        r'"DELETE /authn/sessions/"': "a protected session smoke",
        r"/admin/login/": "a Django admin smoke",
        r"csrfmiddlewaretoken": "a CSRF-protected admin POST smoke",
        r"Revalidate Amplify production rollback point": "a re-validated rollback point",
        r"Deploy production Amplify branch": "a production deployment",
        r"Smoke the production Amplify branch": "production branch smoke tests",
        r"id: canonical_smoke": "canonical production smoke tests",
        r"Roll back production Amplify branch after failed release": "an Amplify rollback",
        (
            r"always\(\) &&\s*\n\s*\(failure\(\) \|\| cancelled\(\)\) &&\s*\n\s*"
            r"steps\.canonical_smoke\.outcome != 'success' &&\s*\n\s*"
            r"steps\.previous_amplify_production\.outcome == 'success' &&\s*\n\s*"
            r"steps\.verify_previous_amplify_artifact\.outcome == 'success' &&\s*\n\s*"
            r"steps\.production_deploy\.outputs\.terminal_confirmed == 'true'"
        ): "a rollback gated on a verified artifact and a terminal production job",
    },
    "infrastructure": {
        **ECS_ENVIRONMENT_RULES,
        **TERRAFORM_STEADY_STATE_RULES,
        r"aws amplify update-app[\s\S]{0,120}--custom-headers": (
            "installation of the reviewed Amplify security headers"
        ),
        r"workflows/\$\{workflow\}/runs\?branch=main&status=success": (
            "application images held at their latest successful releases"
        ),
        r"TF_VAR_backend_image_tag:\s*\$\{\{\s*steps\.images\.outputs\.backend\s*\}\}": (
            "the resolved backend tag in the plan"
        ),
        r"TF_VAR_frontend_image_tag:\s*\$\{\{\s*steps\.images\.outputs\.frontend\s*\}\}": (
            "the resolved fallback frontend tag in the plan"
        ),
        r"-out=infrastructure-release\.tfplan": "a saved infrastructure plan",
        r'startswith\("aws_amplify_branch\."\)': "untouched Amplify branches",
        r'startswith\("aws_amplify_domain_association\."\)': "an untouched Amplify domain",
        r"del\(\.custom_rule\)": "Amplify app changes limited to redirect rules",
        r"requires an administrator-run, reviewed apply": (
            "a redirect of destructive changes to an administrator"
        ),
        r"## Infrastructure plan": "a plan summary for the reviewer",
        r"jq -r '\.static_routes\[\]' src/web/amplify-routes\.json": "static route smoke",
        r"https://\$\{PROD_DOMAIN\}/releviz-smoke-missing-\$\{DEPLOY_SHA\}/\?missing_check=": (
            "canonical unknown-path 404 smoke"
        ),
        r'grep -Fq "Page not found"': "the exported Next 404 document in unknown-path smoke",
    },
}

# The frontend release must keep its steps in this order.
FRONTEND_RELEASE_ORDER = (
    "Install reviewed Amplify security headers",
    "Require the live Amplify domain to serve the production branch",
    "Detect live Amplify not-found routing",
    "Fail closed when an Amplify release job is active",
    "Build Amplify static artifact",
    "Retain immutable Amplify artifact for rollback",
    "Capture current Amplify production rollback point",
    "Resolve retained Amplify rollback artifact",
    "Download retained Amplify rollback artifact",
    "Verify retained Amplify rollback artifact",
    "Deploy candidate Amplify branch",
    "Smoke candidate Amplify frontend and direct API boundary",
    "Revalidate Amplify production rollback point",
    "Deploy production Amplify branch",
    "Smoke the production Amplify branch",
    "Run canonical production smoke tests",
    "Roll back production Amplify branch after failed release",
)

# The backend release must keep its steps in this order.
BACKEND_RELEASE_ORDER = (
    "Release preflight",
    "Build and push immutable backend image",
    "Resolve the ECS fallback frontend image for this plan",
    "Detect live Amplify not-found routing",
    "Plan the backend release",
    "Guard the backend release plan",
    "Apply the exact backend release plan",
    "Wait for backend, workers, and fallback frontend ECS services",
    "Verify ECS services use Terraform-selected task definitions",
    "Verify the backend release identity and worker contract",
    "Verify backend ALB target health",
    "Run backend smoke tests",
    "Ensure production default administrator through one-off ECS task",
    "Clean up an interrupted default-administrator task",
)

INFRASTRUCTURE_RELEASE_ORDER = (
    "Release preflight",
    "Install reviewed Amplify security headers",
    "Resolve the application images for this plan",
    "Plan the infrastructure release",
    "Guard the infrastructure release plan",
    "Apply the exact infrastructure release plan",
    "Wait for ECS services to stabilize on the applied release",
    "Verify ECS services use Terraform-selected task definitions",
    "Verify ALB target health",
    "Run production smoke tests",
)

RELEASE_STEP_ORDERS = {
    "backend": BACKEND_RELEASE_ORDER,
    "frontend": FRONTEND_RELEASE_ORDER,
    "infrastructure": INFRASTRUCTURE_RELEASE_ORDER,
}

RELEASE_PREFLIGHT_RULES = {
    (
        r"\[\s*\"\$TRIGGER_EVENT\"\s*=\s*\"workflow_dispatch\"\s*\]\s*&&\s*"
        r"\[\s*\"\$CONFIRMATION\"\s*!=\s*\"DEPLOY\"\s*\]"
    ): "the DEPLOY confirmation for manual releases",
    r"\^\[0-9a-f\]\{40\}\$": "an immutable release SHA requirement",
    r"git rev-parse HEAD": "exact checked-out release verification",
    r"CI Result": "successful CI enforcement",
    r'environment_name="AWS ECS - Prod"': (
        "the AWS ECS - Prod configuration contract for backend and infrastructure releases"
    ),
    r'environment_name="AWS Amplify - Prod"': (
        "the AWS Amplify - Prod configuration contract for frontend releases"
    ),
    r"Missing required \$\{environment_name\} environment variable": (
        "required configuration checks"
    ),
    r'expected_role_name="releviz-production-github-deploy"': (
        "the reviewed production role name"
    ),
    r'expected_role_name="releviz-production-frontend-github-deploy"': (
        "the reviewed frontend-only role name"
    ),
    r"role/\$\{expected_role_name\}\$": "an exact role ARN contract per scope",
    r':assumed-role/\$\{expected_role_name\}/': "assumed-identity verification per scope",
    r"aws ecs list-clusters --max-items 1 >/dev/null 2>&1; then": (
        "a frontend least-privilege probe"
    ),
    r'DEFAULT_ADMIN_EMAIL"\s*!=\s*"admin@releviz\.com"': (
        "an exact production default-admin identity guard"
    ),
    r"secret:releviz/prod/default-admin-password-\[A-Za-z0-9\]\{6\}\$": (
        "an exact default-admin secret ARN guard"
    ),
    r"\[\$django, \$field, \$metrics, \$admin\]": (
        "a four-way production application-secret uniqueness guard"
    ),
    r'API_DOMAIN"\s*!=\s*"api\.releviz\.com"': "the reviewed API hostname guard",
    r"aws-actions/configure-aws-credentials@v6\.2\.2": "OIDC credential exchange",
    r"role-to-assume:\s*\$\{\{\s*env\.AWS_ROLE_ARN\s*\}\}": "the environment-scoped production role",
    r"role-duration-seconds:\s*3600": "short-lived release credentials",
    r"aws sts get-caller-identity": "deployment identity verification",
    r"secretsmanager describe-secret": "default-admin password secret metadata verification",
    r'"releviz/prod/default-admin-password"': "an exact default-admin Secrets Manager name guard",
    r"kms describe-key --key-id alias/aws/rds": "managed RDS encryption verification",
    r"aws amplify get-app": "Amplify app verification",
    r"get-bucket-versioning": "versioned Terraform state",
    r"get-bucket-encryption": "encrypted Terraform state",
    r"get-public-access-block": "private Terraform state",
    r"terraform_version:\s*1\.15\.8": "the pinned Terraform release",
    r"terraform_wrapper:\s*false": "raw Terraform output and exit semantics",
    r"key=prod/terraform\.tfstate": "the production state key",
    r"use_lockfile=true": "native Terraform state locking",
    r"aws_amplify_domain_association\.frontend\\\[0\\\]": "the completed Amplify domain in state",
    r"aws_route53_record\.api": "the API subdomain record in state",
    r"aws_lb_listener_rule\.backend\\\[0\\\]": "no legacy API compatibility rule in state",
}

RELEASE_SCOPE_RULES = {
    r"\^\[0-9a-f\]\{40\}\$": "an immutable release SHA requirement",
    r'if \[ "\$TRIGGER_EVENT" = "workflow_dispatch" \]': "unconditional manual releases",
    r"runs\?branch=main&status=success&per_page=1": (
        "the last successful release as the diff base"
    ),
    r'base="\$\(last_success deploy-prod\.yml\)"': (
        "the retired single workflow's last release as the initial diff base"
    ),
    r"git cat-file -e": "a rewritten-history fallback",
    r'git diff --name-only "\$base" "\$RELEASE_SHA" --': "a path-scoped change comparison",
    r'echo "release=false"': "a skip when nothing changed",
}


def _step_positions(source: str, names: tuple[str, ...]) -> list[int]:
    return [source.find(f"- name: {name}") for name in names]


def production_cd_errors(root: Path = ROOT) -> list[str]:
    """Ensure the split production releases stay explicit, gated, and health-checked."""

    errors: list[str] = []
    paths = production_release_paths(root)

    for retired in RETIRED_RELEASE_WORKFLOWS:
        if (root / retired).exists():
            errors.append(f"retired single release workflow remains: {retired}")

    for scope in PRODUCTION_RELEASE_WORKFLOWS:
        path = paths[scope]
        if not path.exists():
            errors.append(f"{scope} release workflow is missing")
            continue
        source = path.read_text(encoding="utf-8")
        label = f"{scope} release"
        for pattern, description in COMMON_RELEASE_WORKFLOW_RULES.items():
            if not re.search(pattern, source, re.MULTILINE | re.DOTALL):
                errors.append(f"{label} omits {description}")
        for pattern, description in SCOPED_RELEASE_WORKFLOW_RULES[scope].items():
            if not re.search(pattern, source, re.MULTILINE | re.DOTALL):
                errors.append(f"{label} omits {description}")
        for pattern, description in FORBIDDEN_RELEASE_WORKFLOW_RULES.items():
            if re.search(pattern, source, re.MULTILINE | re.DOTALL):
                errors.append(f"{label} retains {description}")
        for pattern, description in SCOPED_FORBIDDEN_RELEASE_WORKFLOW_RULES[scope].items():
            if re.search(pattern, source, re.MULTILINE | re.DOTALL):
                errors.append(f"{label} retains {description}")
        scope_pattern = rf"release-preflight\s*\n\s*with:\s*\n\s*scope:\s*{scope}\b"
        if not re.search(scope_pattern, source, re.MULTILINE):
            errors.append(f"{label} omits the {scope} preflight scope")
        if not re.search(rf"workflow-file:\s*release-{scope}\.yml", source):
            errors.append(f"{label} omits its own workflow file in the scope comparison")
        positions = _step_positions(source, RELEASE_STEP_ORDERS[scope])
        if any(position < 0 for position in positions):
            missing = [
                name
                for name, position in zip(RELEASE_STEP_ORDERS[scope], positions, strict=True)
                if position < 0
            ]
            errors.append(f"{label} omits ordered steps: {', '.join(missing)}")
        elif positions != sorted(positions):
            errors.append(f"{label} runs its release steps out of the reviewed order")

    preflight = paths["preflight"]
    if not preflight.exists():
        errors.append("release preflight action is missing")
    else:
        source = preflight.read_text(encoding="utf-8")
        for pattern, description in RELEASE_PREFLIGHT_RULES.items():
            if not re.search(pattern, source, re.MULTILINE | re.DOTALL):
                errors.append(f"release preflight omits {description}")
        if re.search(r"\$\{\{\s*secrets\.", source):
            errors.append("release preflight retains GitHub secrets")

    scope_action = paths["scope-action"]
    if not scope_action.exists():
        errors.append("release scope action is missing")
    else:
        source = scope_action.read_text(encoding="utf-8")
        for pattern, description in RELEASE_SCOPE_RULES.items():
            if not re.search(pattern, source, re.MULTILINE | re.DOTALL):
                errors.append(f"release scope omits {description}")
        if re.search(r"aws |configure-aws-credentials", source):
            errors.append("release scope must not use cloud credentials")

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
        r"--connect-timeout": "a bounded presigned-upload connection",
        r"--max-time": "a bounded presigned upload",
        r"--retry-max-time": "a bounded presigned-upload retry window",
        r"AMPLIFY_UPLOAD_CONNECT_TIMEOUT_SECONDS": (
            "a configurable presigned-upload connection timeout"
        ),
        r"AMPLIFY_UPLOAD_MAX_TIME_SECONDS": ("a configurable presigned-upload maximum time"),
        r"AMPLIFY_UPLOAD_RETRY_MAX_TIME_SECONDS": (
            "a configurable presigned-upload retry maximum time"
        ),
        r"helper_started_seconds=\$SECONDS": "an overall timeout clock from helper entry",
        r"deadline=\$\(\(helper_started_seconds\s*\+": (
            "an overall deadline derived from helper entry"
        ),
        r"upload maximum and retry time must fit within the overall timeout": (
            "upload-timeout validation against the overall deadline"
        ),
        r"amplify start-deployment": "start-deployment call",
        r"amplify get-job": "deployment status polling",
        r"amplify stop-job": "failed or interrupted deployment cancellation",
        r'stop_attempts="\$\{AMPLIFY_STOP_ATTEMPTS:-5\}"': ("five bounded cancellation attempts"),
        r'cancel_polls_per_attempt="\$\{AMPLIFY_CANCEL_POLLS_PER_ATTEMPT:-12\}"': (
            "twelve bounded terminal polls per cancellation attempt"
        ),
        r'cancel_poll_seconds="\$\{AMPLIFY_CANCEL_POLL_SECONDS:-5\}"': (
            "five-second cancellation polling"
        ),
        r"terminal_confirmed": "persisted terminal-state evidence",
        r"cancellation_confirmed": "persisted cancellation evidence",
        r"GITHUB_OUTPUT": "persisted deployment job evidence",
        r"AMPLIFY_CANCELLATION_UNCONFIRMED_EXIT_CODE": (
            "a distinct unconfirmed-cancellation failure"
        ),
        r"Do not start a retry or rollback job": ("an explicit active-job rollback safety warning"),
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


def production_alb_security_group_errors(terraform_source: str) -> list[str]:
    start = re.search(
        r'resource\s+"aws_security_group"\s+"alb"\s*\{',
        terraform_source,
    )
    if start is None:
        return ["production Terraform omits the ALB security group"]

    end = re.search(
        r'resource\s+"aws_security_group"\s+"backend"\s*\{',
        terraform_source[start.end() :],
    )
    if end is None:
        return ["production Terraform cannot isolate the ALB security-group block"]

    block = terraform_source[start.start() : start.end() + end.start()]
    errors: list[str] = []
    if not re.search(
        r'description\s*=\s*"Allow public HTTP and HTTPS ingress to the load balancer"',
        block,
    ):
        errors.append(
            "production Terraform changes the immutable live ALB security-group description"
        )
    if not re.search(
        r"lifecycle\s*\{\s*prevent_destroy\s*=\s*true\s*\}",
        block,
    ):
        errors.append("production Terraform omits ALB security-group destroy protection")
    ingress_blocks = re.findall(r"ingress\s*\{(?P<body>[^{}]*)\}", block)
    public_https_patterns = (
        r"from_port\s*=\s*443",
        r"to_port\s*=\s*443",
        r'protocol\s*=\s*"tcp"',
        r'cidr_blocks\s*=\s*\[\s*"0\.0\.0\.0/0"\s*\]',
    )
    if not any(
        all(re.search(pattern, ingress) for pattern in public_https_patterns)
        for ingress in ingress_blocks
    ):
        errors.append("production Terraform omits public IPv4 HTTPS ingress on the ALB")
    return errors


def production_proxy_configuration_errors(terraform_source: str) -> list[str]:
    """Reject the retired CloudFront-origin proxy model."""

    errors: list[str] = []
    trusted_proxy_counts = re.findall(
        (
            r'\{\s*name\s*=\s*"AUTH_TRUSTED_PROXY_COUNT"\s*,'
            r'\s*value\s*=\s*"([^"]+)"\s*\}'
        ),
        terraform_source,
    )
    if trusted_proxy_counts != ["1"]:
        errors.append("production Terraform must set AUTH_TRUSTED_PROXY_COUNT exactly once to 1")

    forbidden_patterns = {
        r"com\.amazonaws\.global\.cloudfront\.origin-facing": (
            "the retired AWS-managed CloudFront origin prefix list"
        ),
        r"(?:var\.)?restrict_origin_to_cloudfront": ("the retired CloudFront-only origin gate"),
        r"(?:var\.)?trust_cloudfront_proxy_chain": (
            "the retired trusted CloudFront proxy-chain gate"
        ),
        r"AUTH_TRUSTED_PROXY_CIDRS": ("the retired CloudFront CIDR runtime allowlist"),
        r"AUTH_TRUSTED_PROXY_CIDR_HOPS": ("the retired CIDR-verified proxy-hop configuration"),
        r"cloudfront_origin_facing\.entries": ("the retired CloudFront prefix-list CIDR expansion"),
    }
    for pattern, description in forbidden_patterns.items():
        if re.search(pattern, terraform_source):
            errors.append(f"production Terraform retains {description}")
    return errors


def production_ecs_task_definition_errors(terraform_source: str) -> list[str]:
    """Keep AWS provider defaults stable across the two-phase production plan."""

    errors: list[str] = []
    canonical_defaults = {
        r"(?m)^[ \t]*enable_fault_injection\s*=\s*false[ \t]*$": (
            "explicitly disabled ECS fault injection"
        ),
        r"(?m)^[ \t]*mountPoints\s*=\s*\[\][ \t]*$": ("canonical empty ECS mount points"),
        r"(?m)^[ \t]*systemControls\s*=\s*\[\][ \t]*$": ("canonical empty ECS system controls"),
        r"(?m)^[ \t]*volumesFrom\s*=\s*\[\][ \t]*$": ("canonical empty ECS volume sources"),
    }
    for pattern, description in canonical_defaults.items():
        if len(re.findall(pattern, terraform_source)) != 5:
            errors.append(
                f"production Terraform must set {description} on all five ECS task definitions"
            )
    return errors


def production_worker_errors(terraform_source: str) -> list[str]:
    """Require the two database-backed workers to be durable and observable."""

    errors: list[str] = []
    worker_contracts = {
        "result_worker": (
            r'command\s*=\s*\[\s*"python"\s*,\s*"manage\.py"\s*,'
            r'\s*"recompute_event_results"\s*,\s*"--watch"\s*,'
            r'\s*"--poll-interval=1"\s*\]'
        ),
        "email_worker": (
            r'command\s*=\s*\[\s*"python"\s*,\s*"manage\.py"\s*,'
            r'[\s\S]*?"dispatch_email_jobs"\s*,[\s\S]*?"--watch"\s*,'
            r'[\s\S]*?"--limit=1000"\s*,[\s\S]*?"--concurrency=10"\s*,'
            r'[\s\S]*?"--rate-limit=10"\s*,[\s\S]*?"--poll-interval=1"\s*,?\s*\]'
        ),
    }
    for name, command_pattern in worker_contracts.items():
        task = _terraform_resource_source(terraform_source, "aws_ecs_task_definition", name)
        service = _terraform_resource_source(terraform_source, "aws_ecs_service", name)
        alarm = _terraform_resource_source(
            terraform_source, "aws_cloudwatch_metric_alarm", f"{name}_running_tasks"
        )
        if not task:
            errors.append(f"production Terraform omits the {name} task definition")
            continue
        for pattern, description in {
            command_pattern: "reviewed watch command",
            r"stopTimeout\s*=\s*120": "graceful stop timeout",
            r"healthCheck\s*=\s*local\.worker_health_check": "database health check",
            r"execution_role_arn\s*=\s*aws_iam_role\.ecs_execution\.arn": ("execution role"),
            r"task_role_arn\s*=\s*aws_iam_role\.ecs_task\.arn": "application task role",
            r"environment\s*=\s*local\.worker_container_environment": (
                "startup-suppressed worker environment"
            ),
            r"secrets\s*=\s*local\.backend_container_secrets": "backend secret allowlist",
        }.items():
            if not re.search(pattern, task, re.MULTILINE | re.DOTALL):
                errors.append(f"production Terraform {name} omits its {description}")
        if not service:
            errors.append(f"production Terraform omits the {name} ECS service")
        else:
            for pattern, description in {
                r"desired_count\s*=\s*1": "single durable replica",
                r"deployment_circuit_breaker\s*\{[\s\S]*?enable\s*=\s*true[\s\S]*?rollback\s*=\s*true": (
                    "automatic rollback"
                ),
                r"assign_public_ip\s*=\s*false": "private networking",
                r"security_groups\s*=\s*\[aws_security_group\.backend\.id\]": (
                    "backend security group"
                ),
            }.items():
                if not re.search(pattern, service, re.MULTILINE | re.DOTALL):
                    errors.append(f"production Terraform {name} service omits {description}")
        if not alarm or not re.search(
            r'metric_name\s*=\s*"RunningTaskCount"[\s\S]*?'
            r'treat_missing_data\s*=\s*"breaching"',
            alarm,
            re.MULTILINE | re.DOTALL,
        ):
            errors.append(f"production Terraform {name} omits its fail-closed running-task alarm")

    worker_environment = _terraform_local_assignment_source(
        terraform_source, "worker_container_environment"
    )
    worker_health_check = _terraform_local_assignment_source(
        terraform_source, "worker_health_check"
    )
    worker_startup_environment = {
        "DJANGO_CREATE_DEFAULT_ADMIN": "0",
        "DJANGO_MIGRATE_ON_START": "1",
        "DJANGO_SKIP_STARTUP_TASKS": "1",
    }
    for name, expected_value in worker_startup_environment.items():
        if not re.search(
            rf'\{{\s*name\s*=\s*"{name}"\s*,\s*value\s*=\s*"{expected_value}"\s*\}}',
            worker_environment,
        ):
            errors.append(f"production worker environment omits {name}")
    if not re.search(
        r'"python\s+manage\.py\s+migrate\s+--check\s+--noinput"',
        worker_health_check,
    ):
        errors.append("production worker health check does not reject pending migrations")

    email_outcome_contracts = {
        "permanent_email_failures": (
            None,
            "permanent_failure",
            "PermanentEmailFailures",
        ),
        "uncertain_email_outcomes": (
            "email_delivery_outcome_uncertain",
            "uncertain",
            "UncertainEmailOutcomes",
        ),
    }
    for name, (event, status, metric_name) in email_outcome_contracts.items():
        metric_filter = _terraform_resource_source(
            terraform_source, "aws_cloudwatch_log_metric_filter", name
        )
        alarm = _terraform_resource_source(terraform_source, "aws_cloudwatch_metric_alarm", name)
        required_filter_patterns = {
            r"log_group_name\s*=\s*aws_cloudwatch_log_group\.email_worker\.name": (
                "email-worker log source"
            ),
            rf"pattern\s*=[^\n]*{re.escape(status)}": "terminal status filter",
            rf'name\s*=\s*"{re.escape(metric_name)}"': "reviewed metric name",
            r'namespace\s*=\s*"Releviz/\$\{var\.environment\}"': ("production metric namespace"),
        }
        if event is not None:
            required_filter_patterns[rf"pattern\s*=[^\n]*{re.escape(event)}"] = (
                "structured event filter"
            )
        for pattern, description in required_filter_patterns.items():
            if not re.search(pattern, metric_filter, re.MULTILINE | re.DOTALL):
                errors.append(f"production Terraform {name} metric filter omits its {description}")
        for pattern, description in {
            rf'metric_name\s*=\s*"{re.escape(metric_name)}"': "reviewed metric",
            r'namespace\s*=\s*"Releviz/\$\{var\.environment\}"': ("production metric namespace"),
            r"threshold\s*=\s*1": "fail-closed threshold",
            r'treat_missing_data\s*=\s*"notBreaching"': "missing-data policy",
            r"alarm_actions\s*=\s*var\.alarm_action_arns": "SNS alarm actions",
        }.items():
            if not re.search(pattern, alarm, re.MULTILINE | re.DOTALL):
                errors.append(f"production Terraform {name} alarm omits its {description}")
    return errors


def production_worker_entrypoint_errors(source: str) -> list[str]:
    """Require worker startup to complete locked migrations without web-only tasks."""

    match = re.search(
        r'if\s+\[\s*"\$\{DJANGO_MIGRATE_ON_START:-0\}"\s*=\s*"1"\s*\]\s*;\s*then'
        r"(?P<migration_only>[\s\S]*?)"
        r'elif\s+\[\s*"\$\{DJANGO_SKIP_STARTUP_TASKS:-0\}"\s*!=\s*"1"\s*\]'
        r"\s*;\s*then",
        source,
    )
    if match is None:
        return ["backend entrypoint omits the worker migration-only startup branch"]

    errors: list[str] = []
    migration_only = match.group("migration_only")
    if not re.search(r"python\s+manage\.py\s+migrate_locked\s+--noinput", migration_only):
        errors.append("backend entrypoint worker startup omits locked migrations")
    if "collectstatic" in migration_only or "ensure_default_admin" in migration_only:
        errors.append("backend entrypoint worker startup runs web-only mutation tasks")
    if not re.search(r'(?m)^exec\s+"\$@"\s*$', source):
        errors.append("backend entrypoint does not exec the worker command after migrations")
    return errors


def _terraform_resource_source(
    terraform_source: str, resource_type: str, resource_name: str
) -> str:
    """Return one top-level resource stanza without attempting to parse HCL."""

    start = re.search(
        rf'(?m)^resource\s+"{re.escape(resource_type)}"\s+'
        rf'"{re.escape(resource_name)}"\s*\{{',
        terraform_source,
    )
    if start is None:
        return ""
    next_resource = re.search(
        r'(?m)^resource\s+"[^"]+"\s+"[^"]+"\s*\{',
        terraform_source[start.end() :],
    )
    end = (
        start.end() + next_resource.start() if next_resource is not None else len(terraform_source)
    )
    return terraform_source[start.start() : end]


def _terraform_local_assignment_source(terraform_source: str, name: str) -> str:
    """Return one two-space-indented assignment from a top-level locals block."""

    start = re.search(
        rf"(?m)^  {re.escape(name)}\s*=",
        terraform_source,
    )
    if start is None:
        return ""
    next_assignment = re.search(
        r"(?m)^  [a-zA-Z_][a-zA-Z0-9_]*\s*=",
        terraform_source[start.end() :],
    )
    end = (
        start.end() + next_assignment.start()
        if next_assignment is not None
        else len(terraform_source)
    )
    return terraform_source[start.start() : end]


def production_default_admin_task_errors(terraform_source: str) -> list[str]:
    """Keep administrator credentials confined to a create-only one-off task."""

    errors: list[str] = []
    backend = _terraform_resource_source(terraform_source, "aws_ecs_task_definition", "backend")
    default_admin = _terraform_resource_source(
        terraform_source, "aws_ecs_task_definition", "default_admin"
    )
    default_admin_environment = _terraform_local_assignment_source(
        terraform_source, "default_admin_container_environment"
    )
    default_admin_secrets = _terraform_local_assignment_source(
        terraform_source, "default_admin_container_secrets"
    )
    if not default_admin:
        return ["production Terraform omits the dedicated default-admin task definition"]

    required_resource = {
        r'family\s*=\s*"\$\{local\.prefix\}-default-admin-task"': (
            "the dedicated default-admin task family"
        ),
        (
            r'command\s*=\s*\[\s*"python"\s*,\s*"manage\.py"\s*,'
            r'\s*"ensure_default_admin"\s*,\s*"--yes"\s*,\s*"--create-only"\s*\]'
        ): "the create-only default-admin command",
        (
            r"environment\s*=\s*local\.default_admin_container_environment"
        ): "the dedicated default-admin environment reference",
        (
            r"secrets\s*=\s*local\.default_admin_container_secrets"
        ): "the dedicated default-admin secrets reference",
        r"image\s*=\s*local\.backend_image_uri": (
            "the immutable backend image in the dedicated default-admin task"
        ),
    }
    for pattern, description in required_resource.items():
        if not re.search(pattern, default_admin, re.MULTILINE | re.DOTALL):
            errors.append(f"production Terraform omits {description}")

    required_environment = {
        (
            r'\{\s*name\s*=\s*"DJANGO_SKIP_STARTUP_TASKS"\s*,'
            r'\s*value\s*=\s*"1"\s*\}'
        ): "startup-task suppression in the default-admin task",
        (
            r'\{\s*name\s*=\s*"DJANGO_CREATE_DEFAULT_ADMIN"\s*,'
            r'\s*value\s*=\s*"0"\s*\}'
        ): "container-start admin-bootstrap suppression",
        (
            r'\{\s*name\s*=\s*"DJANGO_SUPERUSER_EMAIL"\s*,'
            r"\s*value\s*=\s*var\.default_admin_email\s*\}"
        ): "the reviewed default-admin email",
    }
    for pattern, description in required_environment.items():
        if not re.search(
            pattern,
            default_admin_environment,
            re.MULTILINE | re.DOTALL,
        ):
            errors.append(f"production Terraform omits {description}")

    required_secrets = {
        (
            r'\{\s*name\s*=\s*"DJANGO_SUPERUSER_PASSWORD"\s*,?'
            r'\s*valueFrom\s*=\s*"\$\{var\.default_admin_password_secret_arn\}'
            r':password::"\s*\}'
        ): "Secrets Manager password injection in the dedicated task",
    }
    for pattern, description in required_secrets.items():
        if not re.search(
            pattern,
            default_admin_secrets,
            re.MULTILINE | re.DOTALL,
        ):
            errors.append(f"production Terraform omits {description}")

    if re.search(r"(?m)^[ \t]*task_role_arn\s*=", default_admin):
        errors.append("the default-admin task must not receive an application task role")
    if "ENABLE_LEGACY_API_PREFIX" in (
        default_admin + default_admin_environment + default_admin_secrets
    ):
        errors.append("the default-admin task must not vary with legacy API compatibility")
    if "DJANGO_SUPERUSER_PASSWORD" in backend:
        errors.append("the long-running backend task must not receive the default-admin password")
    if "DJANGO_SUPERUSER_EMAIL" in backend:
        errors.append(
            "the long-running backend task must not receive default-admin bootstrap inputs"
        )
    application_secret_arns = _terraform_local_assignment_source(
        terraform_source, "application_secret_arns"
    )
    if not re.search(
        r"application_secret_arns\s*=\s*compact\(\[[\s\S]{0,300}"
        r"var\.default_admin_password_secret_arn",
        application_secret_arns,
    ):
        errors.append(
            "the ECS execution role secret allowlist omits the default-admin password ARN"
        )
    return errors


def production_amplify_custom_headers_policy_errors(source: str) -> list[str]:
    """Require the reviewed policy shape accepted by Amplify's customHeaders API."""

    try:
        payload = json.loads(source)
    except json.JSONDecodeError:
        return ["production Amplify custom-header policy is not valid JSON"]

    if not isinstance(payload, dict):
        return ["production Amplify custom-header policy must be a top-level JSON object"]
    if not isinstance(payload.get("customHeaders"), list):
        return ["production Amplify custom-header policy omits the top-level customHeaders list"]
    policies = payload["customHeaders"]
    if len(policies) != 1 or policies[0].get("pattern") != "**":
        return ["production Amplify custom-header policy must contain one global policy"]
    headers = policies[0].get("headers")
    if not isinstance(headers, list):
        return ["production Amplify custom-header policy omits its headers list"]
    csp_values = [
        header.get("value")
        for header in headers
        if isinstance(header, dict) and header.get("key") == "Content-Security-Policy"
    ]
    if len(csp_values) != 1 or not isinstance(csp_values[0], str):
        return ["production Amplify custom-header policy must contain one CSP string"]

    csp = csp_values[0]
    errors: list[str] = []
    for forbidden in ("'unsafe-eval'", "esm.run", "blob:", " ws:", " wss:"):
        if forbidden in csp:
            errors.append(f"production Amplify CSP retains forbidden source {forbidden.strip()}")
    required_directives = (
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
        "connect-src 'self' https://api.releviz.com https://challenges.cloudflare.com",
        "frame-src 'self' https://challenges.cloudflare.com",
        "form-action 'self'",
        "upgrade-insecure-requests",
    )
    for directive in required_directives:
        if directive not in csp:
            errors.append(f"production Amplify CSP omits reviewed directive: {directive}")
    return errors


def production_amplify_custom_headers_errors(terraform_source: str) -> list[str]:
    """Require format-insensitive but semantic Amplify header drift detection."""

    start = re.search(
        r'resource\s+"aws_amplify_app"\s+"frontend"\s*\{',
        terraform_source,
    )
    if start is None:
        return ["production Terraform omits the Amplify frontend app"]

    end = re.search(
        r'resource\s+"aws_amplify_branch"\s+"candidate"\s*\{',
        terraform_source[start.end() :],
    )
    if end is None:
        return ["production Terraform cannot isolate the Amplify frontend app block"]

    block = terraform_source[start.start() : start.end() + end.start()]
    errors: list[str] = []
    if not re.search(
        (
            r"(?m)^[ \t]*custom_headers\s*=\s*"
            r"file\(\s*\"\$\{path\.module\}/amplify-custom-headers\.json\"\s*\)[ \t]*$"
        ),
        block,
    ):
        errors.append(
            "production Terraform does not render Amplify custom headers from "
            "the reviewed policy file"
        )
    if not re.search(
        r"(?m)^[ \t]*ignore_changes\s*=\s*\[\s*custom_headers\s*\][ \t]*$",
        block,
    ):
        errors.append(
            "production Terraform does not suppress provider-only Amplify "
            "custom-header formatting drift"
        )

    postconditions = re.findall(
        r"(?ms)^[ \t]*postcondition\s*\{(?P<body>[^{}]*)^[ \t]*\}",
        block,
    )
    semantic_patterns = (
        r"(?m)^[ \t]*condition\s*=\s*try\(",
        r"jsonencode\(\s*try\(",
        (
            r"(?m)^[ \t]*yamldecode\(\s*self\.custom_headers\s*\)"
            r"\.customHeaders,[ \t]*$"
        ),
        r"(?m)^[ \t]*yamldecode\(\s*self\.custom_headers\s*\),[ \t]*$",
        r"\)\s*==\s*jsonencode\(\s*local\.amplify_custom_headers\s*\)",
        r"(?m)^[ \t]*false,[ \t]*$",
    )
    if not any(
        all(re.search(pattern, postcondition) for pattern in semantic_patterns)
        for postcondition in postconditions
    ):
        errors.append(
            "production Terraform does not reject semantic JSON or YAML drift "
            "in live Amplify custom headers"
        )
    return errors


def deployment_contract_errors(root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    custom_headers_path = root / PRODUCTION_AMPLIFY_CUSTOM_HEADERS.relative_to(ROOT)
    if custom_headers_path.exists():
        errors.extend(
            production_amplify_custom_headers_policy_errors(
                custom_headers_path.read_text(encoding="utf-8")
            )
        )
    else:
        errors.append("production Amplify custom-header policy is missing")

    settings_path = root / PRODUCTION_SETTINGS.relative_to(ROOT)
    required = required_runtime_environment(settings_path.read_text(encoding="utf-8"))

    for environment, path in TERRAFORM_ENVIRONMENTS.items():
        candidate = root / path.relative_to(ROOT)
        provided = terraform_environment_names(candidate.read_text(encoding="utf-8"))
        missing = sorted(required - provided)
        if missing:
            errors.append(f"{environment} Terraform omits runtime settings: {', '.join(missing)}")

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
        r'resource\s+"aws_ecs_service"\s+"result_worker"': ("a durable result-worker ECS service"),
        r'resource\s+"aws_ecs_service"\s+"email_worker"': ("a durable email-worker ECS service"),
        r'resource\s+"aws_ecs_service"\s+"frontend"': "a frontend ECS rollback service",
        r"assign_public_ip\s*=\s*false": "private ECS networking",
        r"multi_az\s*=\s*true": "Multi-AZ PostgreSQL",
        r"manage_master_user_password\s*=\s*true": "an RDS-managed database password",
        r"deployment_circuit_breaker\s*\{": "ECS automatic rollback",
        r"alarm_actions\s*=\s*var\.alarm_action_arns": "monitored alarm actions",
        r'resource\s+"aws_amplify_app"\s+"frontend"': "an Amplify frontend app",
        r'platform\s*=\s*"WEB"': "static Amplify hosting",
        r'resource\s+"aws_amplify_branch"\s+"candidate"': "an Amplify candidate branch",
        r'resource\s+"aws_amplify_branch"\s+"production"': ("an Amplify production branch"),
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
        (
            r'\{\s*name\s*=\s*"AUTH_TRUSTED_PROXY_COUNT"\s*,'
            r'\s*value\s*=\s*"1"\s*\}'
        ): "one-hop public ALB proxy trust",
        r'xff_header_processing_mode\s*=\s*"append"': "explicit ALB XFF append mode",
        r"enable_xff_client_port\s*=\s*false": "port-free ALB XFF addresses",
        r"amplify-routes\.json": "a shared Amplify static route manifest",
        r"amplify-custom-headers\.json": "a reviewed Amplify security-header policy",
        r'resource\s+"aws_route53_record"\s+"api"': "an API-domain ALB alias",
        r'resource\s+"aws_lb_listener_certificate"\s+"api"': ("an API-domain ALB certificate"),
        r'resource\s+"aws_lb_listener_rule"\s+"backend_api_host"': (
            "host-wide API-domain backend routing"
        ),
        r"enable_legacy_api_compatibility": ("a bounded first-release compatibility switch"),
        r'\{\s*name\s*=\s*"BACKEND_URL"\s*,\s*value\s*=\s*local\.api_url\s*\}': (
            "the canonical API URL in the backend runtime"
        ),
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
    errors.extend(production_alb_security_group_errors(production_terraform))
    errors.extend(production_proxy_configuration_errors(production_terraform))
    errors.extend(production_ecs_task_definition_errors(production_terraform))
    errors.extend(production_worker_errors(production_terraform))
    entrypoint_path = root / BACKEND_ENTRYPOINT.relative_to(ROOT)
    if entrypoint_path.exists():
        errors.extend(
            production_worker_entrypoint_errors(entrypoint_path.read_text(encoding="utf-8"))
        )
    else:
        errors.append("backend entrypoint is missing")
    errors.extend(production_default_admin_task_errors(production_terraform))
    errors.extend(production_amplify_custom_headers_errors(production_terraform))

    bootstrap_terraform = (root / BOOTSTRAP_TERRAFORM.relative_to(ROOT)).read_text(encoding="utf-8")
    for pattern, description in {
        r'backend\s+"s3"\s*\{\s*\}': "an S3 backend declaration for migrated bootstrap state",
        r"existing_github_oidc_provider_arn": "an explicit shared GitHub OIDC provider input",
        r"from\s*=\s*aws_iam_openid_connect_provider\.github": (
            "a non-destructive legacy OIDC state removal"
        ),
        r"destroy\s*=\s*false": "a shared OIDC provider preservation guard",
        r'"route53:ListHostedZones"': (
            "the observed Amplify Route53 hosted-zone discovery permission"
        ),
        r"length\(var\.production_secret_arns\)\s*>=\s*4": (
            "metadata access for all four production application secrets"
        ),
        r'Sid\s*=\s*"RunProductionDefaultAdminTask"': (
            "a separate default-admin task launch permission"
        ),
        (
            r"task-definition/releviz-prod-default-admin-task:\*"
        ): "a task-family-scoped default-admin launch permission",
        (
            r'ArnEquals\s*=\s*\{[\s\S]{0,160}"ecs:cluster"'
            r"\s*=\s*local\.production_cluster_arn"
        ): "an exact production-cluster condition on the default-admin task",
        r'Sid\s*=\s*"StopProductionDefaultAdminTask"': (
            "a separate tagged default-admin task cleanup permission"
        ),
        r"task/releviz-prod-cluster/\*": (
            "a production-cluster task scope for default-admin cleanup"
        ),
        r'"aws:RequestTag/Project"\s*=\s*"releviz"': (
            "the default-admin Project request-tag guard"
        ),
        r'"aws:RequestTag/Environment"\s*=\s*"prod"': (
            "the default-admin Environment request-tag guard"
        ),
        r'"aws:RequestTag/Purpose"\s*=\s*"default-admin-bootstrap"': (
            "the default-admin Purpose request-tag guard"
        ),
        r'"ForAllValues:StringEquals"\s*=\s*\{[\s\S]{0,120}'
        r'"aws:TagKeys"\s*=\s*\[[\s\S]{0,120}"Project"'
        r'[\s\S]{0,80}"Environment"[\s\S]{0,80}"Purpose"': (
            "an exact default-admin request tag-key allowlist"
        ),
        r'"aws:ResourceTag/Project"\s*=\s*"releviz"': (
            "the default-admin cleanup Project tag guard"
        ),
        r'"aws:ResourceTag/Environment"\s*=\s*"prod"': (
            "the default-admin cleanup Environment tag guard"
        ),
        r'"aws:ResourceTag/Purpose"\s*=\s*"default-admin-bootstrap"': (
            "the default-admin cleanup Purpose tag guard"
        ),
        r"production_ecs_role_arns\s*=\s*\[[\s\S]{0,250}"
        r"releviz-prod-ecs-execution-role[\s\S]{0,150}"
        r"releviz-prod-ecs-task-role": "the two exact production ECS role ARNs",
        r'Sid\s*=\s*"PassExactProductionEcsRoles"[\s\S]{0,350}'
        r"Resource\s*=\s*local\.production_ecs_role_arns[\s\S]{0,250}"
        r'"iam:PassedToService"\s*=\s*"ecs-tasks\.amazonaws\.com"': (
            "exact ECS role passing limited to the ECS tasks service"
        ),
        r"production_eventbridge_role_arn\s*=\s*"
        r'"arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:'
        r'role/releviz-prod-eventbridge-reminders-role"': (
            "the exact production EventBridge role ARN"
        ),
        r'Sid\s*=\s*"PassExactProductionEventBridgeRole"[\s\S]{0,350}'
        r"Resource\s*=\s*local\.production_eventbridge_role_arn[\s\S]{0,250}"
        r'"iam:PassedToService"\s*=\s*"events\.amazonaws\.com"': (
            "exact EventBridge role passing limited to the EventBridge service"
        ),
    }.items():
        if not re.search(pattern, bootstrap_terraform):
            errors.append(f"bootstrap Terraform omits {description}")
    if re.search(r'resource\s+"aws_iam_openid_connect_provider"', bootstrap_terraform):
        errors.append("bootstrap Terraform must not manage the shared GitHub OIDC provider")

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
