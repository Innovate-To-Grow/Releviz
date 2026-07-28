#!/usr/bin/env python3
"""Keep runtime requirements, Terraform, and deployment workflows aligned."""

from __future__ import annotations

import ast
import json
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
PRODUCTION_AMPLIFY_CUSTOM_HEADERS = ROOT / "infra/prod/amplify-custom-headers.json"
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
        r"timeout-minutes:\s*160": "the reviewed 160-minute production job limit",
        r'PRODUCTION_JOB_TIMEOUT_SECONDS:\s*"9600"': (
            "the production job timeout in seconds"
        ),
        r'AMPLIFY_TIMEOUT_SECONDS:\s*"1200"': (
            "the bounded Amplify deployment-helper timeout"
        ),
        r"Record production job time budget": "production job start-time capture",
        r"actions:\s*read": "GitHub Actions artifact read permission",
        r"id-token:\s*write": "OIDC permission",
        r"terraform_wrapper:\s*false": "raw Terraform output and exit semantics",
        r"CONFIRMATION.*DEPLOY|CONFIRMATION\"\s*!=\s*\"DEPLOY\"": "explicit confirmation",
        r"git rev-parse HEAD": "exact checked-out release verification",
        r"CI Result": "successful CI enforcement",
        r"backend_image_tag.*DEPLOY_SHA": "immutable backend release tag",
        r"describe-task-definition": "deployed ECS frontend rollback discovery",
        r"frontend_image_tag.*github\.sha": "immutable ECS fallback frontend release tag",
        (
            r"Plan production infrastructure with current DNS state"
            r"[\s\S]{0,500}TF_VAR_frontend_image_tag:\s*\$\{\{\s*"
            r"steps\.rollback_frontend\.outputs\.sha\s*\}\}"
            r"[\s\S]{0,500}production-base\.tfplan"
        ): "the deployed ECS frontend SHA in the base Terraform plan",
        r"Build and push immutable ECS fallback frontend image": (
            "an API-aware ECS frontend fallback build"
        ),
        r"NEXT_PUBLIC_API_BASE_URL=https://\$\{API_DOMAIN\}": (
            "the API subdomain baked into the ECS frontend fallback"
        ),
        r"Detect API-subdomain transition state": (
            "one-time legacy API compatibility detection"
        ),
        r"Install reviewed Amplify security headers": (
            "the reviewed cross-origin frontend policy"
        ),
        r"amplify update-app[\s\S]{0,160}--custom-headers": (
            "an explicit Amplify custom-header update"
        ),
        r"npm ci --workspace=releviz-frontend": "locked frontend dependency install",
        r"run build:amplify": "Amplify static frontend build",
        r"validate_amplify_static_export\.py": (
            "Amplify static route and asset validation"
        ),
        r"src/frontend/out": "static export artifact",
        r"AMPLIFY_ARTIFACT.*\.sha256": "a retained static-artifact checksum",
        r"retention-days:\s*90": "a 90-day rollback artifact retention window",
        r"release\.json": "immutable frontend release identity",
        r"release_sha.*DEPLOY_SHA": "deployed frontend SHA verification",
        r"amplify-static-deploy\.sh": "manual Amplify deployment helper",
        r"Capture current Amplify production rollback point": (
            "a live Amplify rollback point"
        ),
        r"Resolve retained Amplify rollback artifact": (
            "a retained rollback-artifact resolver"
        ),
        r"releviz-amplify-(?:\$\{?)?PREVIOUS_SHA": (
            "an exact previous-SHA rollback artifact name"
        ),
        r"actions/artifacts": "a repository artifact metadata lookup",
        r"gh api[\s\S]{0,100}--method\s+GET": (
            "an explicit read-only artifact API request"
        ),
        r"--paginate[\s\S]{0,100}--slurp": (
            "complete paginated rollback artifact discovery"
        ),
        r"\.name\s*==\s*\$(?:name|artifact_name)": (
            "exact rollback artifact-name matching"
        ),
        (
            r"\.expired\s*==\s*false|"
            r"select\(\s*\.expired\s*\|\s*not\s*\)|"
            r"select\(\s*\(\.expired\s*//\s*true\)\s*==\s*false\s*\)"
        ): "an unexpired rollback-artifact requirement",
        (
            r"\.workflow_run\.head_sha\s*==\s*\$(?:sha|previous_sha)|"
            r"\$(?:sha|previous_sha)\s*==\s*\.workflow_run\.head_sha"
        ): "rollback artifact head-SHA binding",
        (
            r"(?:\.workflow_run\.)?\.?head_branch\s*==\s*\"main\"|"
            r"head_branch[\s\S]{0,100}\bmain\b"
        ): "rollback artifact main-branch binding",
        r"\.github/workflows/deploy-prod\.yml": (
            "rollback artifact production-workflow binding"
        ),
        (
            r"\.event\s*==\s*\"workflow_dispatch\"|"
            r"workflow_dispatch[\s\S]{0,100}\.event"
        ): "rollback artifact workflow-dispatch binding",
        r"\.status\s*==\s*\"completed\"": ("a completed trusted rollback workflow run"),
        (
            r"\.head_repository\.full_name[\s\S]{0,120}GITHUB_REPOSITORY|"
            r"GITHUB_REPOSITORY[\s\S]{0,120}\.head_repository\.full_name|"
            r'--arg\s+repository\s+"\$GITHUB_REPOSITORY"'
            r"[\s\S]{0,500}\.head_repository\.full_name\s*==\s*\$repository"
        ): "rollback artifact source-repository binding",
        r"artifact_id": "an immutable rollback artifact ID",
        r"run_id": "the rollback artifact's workflow-run ID",
        r"Download retained Amplify rollback artifact": (
            "a retained rollback-artifact download"
        ),
        r"uses:\s*actions/download-artifact@v8": (
            "the reviewed cross-run artifact downloader"
        ),
        r"artifact-ids:": "rollback download by immutable artifact ID",
        r"github-token:": "authenticated cross-run artifact download",
        r"repository:": "an exact rollback artifact repository",
        r"run-id:": "an exact rollback artifact workflow run",
        r"digest-mismatch:\s*error": "fail-closed GitHub artifact digest validation",
        r"(?:RUNNER_TEMP|runner\.temp)[\s\S]{0,100}amplify-rollback": (
            "an isolated rollback artifact download directory"
        ),
        r"Verify retained Amplify rollback artifact": (
            "strict retained rollback-artifact verification"
        ),
        r"retained_entries[\s\S]{0,300}-ne\s+2": (
            "an exact two-file retained artifact payload"
        ),
        r"\[0-9a-f\]\{64\}": "a strict rollback checksum digest format",
        (
            r"BASH_REMATCH\[[0-9]+\][\s\S]{0,150}expected_archive|"
            r"checksum_(?:name|filename)[\s\S]{0,150}expected_archive"
        ): "an exact rollback checksum filename",
        r"sha256sum[^\n]*(?:--check|-c)[^\n]*--strict[^\n]*--status": (
            "strict inner rollback ZIP checksum verification"
        ),
        r"unzip\s+-tq": "inner rollback ZIP integrity verification",
        r"(?:zipinfo\s+-1|unzip\s+-Z1)": "inner rollback ZIP entry validation",
        r"unsafe (?:path|ZIP entry)": "unsafe inner rollback ZIP path rejection",
        r"grep\s+-cx\s+['\"]release\.json['\"][^\n]*-ne\s+1": (
            "exactly one root rollback release manifest"
        ),
        (
            r"unzip\s+-p[^\n]*release\.json[\s\S]{0,300}PREVIOUS_SHA|"
            r"PREVIOUS_SHA[\s\S]{0,300}unzip\s+-p[^\n]*release\.json"
        ): "inner rollback release-SHA verification",
        r"Roll back production Amplify branch after failed release": (
            "automatic rollback after any failed live release stage"
        ),
        (
            r"steps\.production_deploy\.outputs\.terminal_confirmed\s*==\s*'true'"
        ): "a confirmed-terminal current job before Amplify rollback",
        (
            r"Roll back production Amplify branch after failed release"
            r"[\s\S]{0,1800}scripts/deploy/amplify-static-deploy\.sh"
        ): "manual redeployment of the verified rollback artifact",
        (
            r'for\s+base_url\s+in\s+"\$production_url"\s+'
            r'"https://\$\{PROD_DOMAIN\}"[\s\S]{0,1200}'
            r'"\$\{base_url\}/release\.json"[\s\S]{0,500}'
            r'"\$PREVIOUS_SHA"'
        ): "rollback release identity checks on both default and production domains",
        r"Smoke candidate Amplify frontend and direct API boundary": (
            "candidate frontend and direct API boundary smoke tests"
        ),
        r"\.static_routes\[\]": "all exported candidate routes in smoke tests",
        r"\.legacy_redirects \| keys\[\]": (
            "legacy Amplify redirects in candidate smoke tests"
        ),
        r"event/\?code=AMPLIFYSMOKE": (
            "query-preserving trailing-slash route verification"
        ),
        r"src/frontend/out/_next/static": "a deployed static-asset smoke test",
        r"PUT /authn/profile": "a direct protected PUT smoke test",
        r"DELETE /authn/sessions": "a direct protected DELETE smoke test",
        r"Access-Control-Request-Method:\s*PUT": (
            "a direct credentialed API CORS preflight"
        ),
        r"access-control-allow-origin": "an exact API CORS origin check",
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
        r"terraform -chdir=infra/prod state pull": (
            "exact Terraform instance-state inspection"
        ),
        r'\.status // "ready"': "tainted Amplify domain-state detection",
        r"Recovered the verified Amplify domain association from tainted Terraform state": (
            "verified tainted-domain state recovery"
        ),
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
        r"Verify preserved canonical alias immediately before cutover": (
            "a pre-cutover DNS race guard"
        ),
        r"refusing cutover": "a fail-closed pre-cutover DNS race guard",
        r"Require a safe live-branch mutation budget": (
            "a reserved live-branch rollback window before production mutation"
        ),
        r"TF_VAR_enable_amplify_domain.*domain_state\.outputs\.preexisting": (
            "non-destructive initial domain state"
        ),
        r'TF_VAR_enable_amplify_domain:\s*"true"': "reviewed Amplify domain association",
        (
            r"Plan reviewed Amplify domain association"
            r"[\s\S]{0,500}TF_VAR_frontend_image_tag:\s*\$\{\{\s*"
            r"steps\.rollback_frontend\.outputs\.sha\s*\}\}"
            r"[\s\S]{0,500}production-domain\.tfplan"
        ): "the deployed ECS frontend SHA in the domain Terraform plan",
        r"terraform -chdir=infra/prod show -json production-domain\.tfplan": (
            "machine-readable Amplify domain plan review"
        ),
        r'\.change\.actions \| index\("delete"\)\) == null': (
            "a no-destroy Amplify domain plan gate"
        ),
        r"Wait for Amplify custom domain availability": "custom-domain readiness gate",
        r"Require a safe first-cutover time budget": (
            "a reserved DNS-compensation window before first cutover"
        ),
        r"Apply exact Amplify domain association plan": (
            "application of the exact reviewed domain-association plan"
        ),
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
        (
            r"Plan final production topology"
            r"[\s\S]{0,700}TF_VAR_frontend_image_tag:\s*\$\{\{\s*github\.sha\s*\}\}"
        ): "the current frontend SHA in the final Terraform plan",
        (
            r"Plan final production topology"
            r"[\s\S]{0,700}TF_VAR_enable_legacy_api_compatibility:\s*\"false\""
        ): "retired API compatibility in the final Terraform plan",
        (
            r"Plan final production topology[\s\S]{0,700}production-final\.tfplan"
        ): "the exact final production topology plan",
        (
            r"Apply exact final production topology plan"
            r"[\s\S]{0,500}terraform\s+-chdir=infra/prod\s+apply"
            r"[\s\S]{0,300}production-final\.tfplan"
        ): "application of the exact final production topology plan",
        r"Verify final API-only backend topology": (
            "a final direct API and retired frontend-proxy verification"
        ),
        r"https://\$\{API_DOMAIN\}/api/health": (
            "verification that the old API prefix is retired"
        ),
        r"Restore pre-release canonical Route53 alias after failed first cutover": (
            "automatic first-cutover DNS compensation"
        ),
        (
            r"Restore pre-release canonical Route53 alias after failed first cutover"
            r"[\s\S]{0,700}steps\.canonical_smoke\.outcome\s*!=\s*'success'"
        ): "a canonical-smoke failure guard on first-cutover DNS compensation",
        r"route53 change-resource-record-sets": "an atomic Route53 alias restoration",
        r'Action:\s*"UPSERT"': "a non-destructive canonical alias UPSERT",
        r"route53 wait resource-record-sets-changed": (
            "authoritative DNS change propagation"
        ),
        r"AMPLIFY_ALIAS_FILE": "a captured post-cutover alias race guard",
        r"amplify-apex-target\.sh": (
            "service-reported Amplify apex-target extraction during compensation"
        ),
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

    def marker_section(start_marker: str, end_marker: str) -> str:
        start = source.find(start_marker)
        end = source.find(end_marker, start + len(start_marker))
        if start < 0 or end < 0:
            return ""
        return source[start:end]

    steps_match = re.search(r"(?m)^(?P<indent>[ \t]*)steps:\s*$", source)
    first_step = ""
    if steps_match is not None:
        step_indent = f"{steps_match.group('indent')}  "
        steps_source = source[steps_match.end() :]
        first_step_match = re.search(
            rf"(?m)^{re.escape(step_indent)}-\s+(?:name|uses|run):[^\n]*",
            steps_source,
        )
        if first_step_match is not None:
            next_step_match = re.search(
                rf"(?m)^{re.escape(step_indent)}-\s+(?:name|uses|run):[^\n]*",
                steps_source[first_step_match.end() :],
            )
            first_step_end = (
                first_step_match.end() + next_step_match.start()
                if next_step_match is not None
                else len(steps_source)
            )
            first_step = steps_source[first_step_match.start() : first_step_end]
    if not re.search(
        r"(?m)^-\s+name:\s*Record production job time budget\s*$",
        first_step.lstrip(),
    ):
        errors.append("production CD does not record the job epoch in its first step")
    first_step_budget_patterns = {
        r"(?m)^\s*id:\s*job_budget\s*$": "a stable production job-budget step ID",
        r"started_at=\$\(date \+%s\)": "the production job start epoch",
        r"GITHUB_OUTPUT": "persisted production job start-time evidence",
    }
    for pattern, description in first_step_budget_patterns.items():
        if not re.search(pattern, first_step):
            errors.append(f"production CD omits {description} from its first step")

    domain_plan_to_apply = marker_section(
        "Plan reviewed Amplify domain association",
        "Apply exact Amplify domain association plan",
    )
    cutover_budget_start = domain_plan_to_apply.find(
        "Require a safe first-cutover time budget"
    )
    cutover_budget = (
        domain_plan_to_apply[cutover_budget_start:] if cutover_budget_start >= 0 else ""
    )
    cutover_budget_patterns = {
        (
            r"if:\s*\$\{\{\s*steps\.apex_alias\.outputs\.routes_to_alb"
            r"\s*==\s*'true'\s*\}\}"
        ): "ALB-only first-cutover budget enforcement",
        (
            r"JOB_STARTED_AT:\s*\$\{\{\s*"
            r"steps\.job_budget\.outputs\.started_at\s*\}\}"
        ): "the recorded production job start epoch in the first-cutover guard",
        r'now="\$\(date \+%s\)"': "current epoch calculation in the first-cutover guard",
        r"elapsed=\$\(\(now\s*-\s*JOB_STARTED_AT\)\)": (
            "elapsed job-time calculation in the first-cutover guard"
        ),
        (r"remaining=\$\(\(PRODUCTION_JOB_TIMEOUT_SECONDS\s*-\s*elapsed\)\)"): (
            "remaining job-time calculation from the reviewed timeout before "
            "first cutover"
        ),
        r"compensation_reserve=\$\(\(70\s*\*\s*60\)\)": (
            "the 4,200-second DNS-compensation reserve"
        ),
        (
            r'if\s+\[\s*"\$remaining"\s*-lt\s*'
            r'"\$compensation_reserve"\s*\]\s*;\s*then'
        ): "fail-closed first-cutover time-budget comparison",
        r"(?m)^\s*exit\s+1\s*$": "first-cutover refusal when time is insufficient",
    }
    for pattern, description in cutover_budget_patterns.items():
        if not re.search(pattern, cutover_budget, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description}")
    domain_plan_position = source.find("Plan reviewed Amplify domain association")
    cutover_budget_position = source.find("Require a safe first-cutover time budget")
    domain_apply_position = source.find("Apply exact Amplify domain association plan")
    if not (
        0 <= domain_plan_position < cutover_budget_position < domain_apply_position
    ):
        errors.append(
            "production CD must place the first-cutover budget guard after the "
            "domain plan and before its apply"
        )
    else:
        domain_apply_line_start = source.rfind("\n", 0, domain_apply_position) + 1
        if re.search(
            r"(?m)^[ \t]+-\s+(?:name|uses|run):",
            source[
                cutover_budget_position
                + len(
                    "Require a safe first-cutover time budget"
                ) : domain_apply_line_start
            ],
        ):
            errors.append(
                "production CD must place the first-cutover budget guard immediately "
                "before the domain apply"
            )

    live_branch_budget = marker_section(
        "Require a safe live-branch mutation budget",
        "Deploy production Amplify branch",
    )
    live_branch_budget_patterns = {
        (
            r"JOB_STARTED_AT:\s*\$\{\{\s*"
            r"steps\.job_budget\.outputs\.started_at\s*\}\}"
        ): "the recorded production job start epoch in the live-branch guard",
        r'now="\$\(date \+%s\)"': "current epoch calculation in the live-branch guard",
        r"elapsed=\$\(\(now\s*-\s*JOB_STARTED_AT\)\)": (
            "elapsed job-time calculation in the live-branch guard"
        ),
        (r"remaining=\$\(\(PRODUCTION_JOB_TIMEOUT_SECONDS\s*-\s*elapsed\)\)"): (
            "remaining job-time calculation from the reviewed timeout before "
            "live-branch mutation"
        ),
        r"rollback_reserve=\$\(\(90\s*\*\s*60\)\)": (
            "the 5,400-second live-branch rollback reserve"
        ),
        (
            r'if\s+\[\s*"\$remaining"\s*-lt\s*'
            r'"\$rollback_reserve"\s*\]\s*;\s*then'
        ): "fail-closed live-branch time-budget comparison",
        r"(?m)^\s*exit\s+1\s*$": "live-branch refusal when time is insufficient",
    }
    for pattern, description in live_branch_budget_patterns.items():
        if not re.search(pattern, live_branch_budget, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description}")

    candidate_smoke = marker_section(
        "Smoke candidate Amplify frontend and direct API boundary",
        "Revalidate Amplify production rollback point",
    )
    candidate_admin_patterns = {
        r"\$\{api_url\}/admin/login/": "the direct Django admin login page",
        r"csrfmiddlewaretoken": "a Django admin CSRF form token",
        r"<form": "the Django admin login form",
        r"\$\{api_url\}/static/admin/css/base\.css": (
            "the direct Django admin static asset"
        ),
    }
    for pattern, description in candidate_admin_patterns.items():
        if not re.search(pattern, candidate_smoke, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description} in candidate smoke")
    if re.search(
        r'if\s+\[\s*"\$admin_post_status"\s*!=\s*"400"\s*\]\s*;\s*then',
        candidate_smoke,
    ):
        errors.append(
            "production CD retains an exclusive custom 400 Django admin contract"
        )
    if "Please enter valid staff account credentials." in candidate_smoke:
        errors.append(
            "production CD retains a custom Django admin error-message contract"
        )

    production_branch_smoke = marker_section(
        "Smoke production Amplify branch before domain cutover",
        "Verify preserved canonical alias immediately before cutover",
    )
    canonical_smoke = marker_section(
        "Run canonical production smoke tests",
        "Plan final production topology",
    )
    bounded_smokes = (
        ("production branch", production_branch_smoke, 600),
        ("canonical production", canonical_smoke, 600),
    )
    for scope, section, deadline_seconds in bounded_smokes:
        deadline_patterns = {
            rf"phase_deadline=\$\(\(SECONDS\s*\+\s*{deadline_seconds}\)\)": (
                f"a {deadline_seconds}-second hard deadline"
            ),
            r"bounded_curl\(\)": "the deadline-aware curl wrapper",
            r"remaining=\$\(\(phase_deadline\s*-\s*SECONDS\)\)": (
                "per-request remaining-time calculation"
            ),
            r'if\s+\[\s*"\$remaining"\s*-le\s*0\s*\]\s*;\s*then': (
                "fail-closed exhausted-deadline handling"
            ),
            (
                r'timeout\s+--signal=TERM\s+"\$\{remaining\}s"\s+curl\s+"\$@"'
            ): "an operating-system-enforced curl deadline",
            r"if\s+\(\(SECONDS\s*>=\s*phase_deadline\)\)\s*;\s*then": (
                "deadline enforcement inside convergence polling"
            ),
        }
        for pattern, description in deadline_patterns.items():
            if not re.search(pattern, section, re.MULTILINE | re.DOTALL):
                errors.append(f"production CD omits {description} in {scope} smoke")

    response_header_smokes = (
        (
            "candidate Amplify",
            candidate_smoke,
            (
                r'--dump-header\s+"\$candidate_security_headers"'
                r'[\s\S]{0,200}"\$\{candidate_url\}/"'
            ),
        ),
        (
            "canonical Amplify",
            canonical_smoke,
            (
                r'--dump-header\s+"\$canonical_security_headers"'
                r'[\s\S]{0,200}"https://\$\{PROD_DOMAIN\}/"'
            ),
        ),
    )
    reviewed_response_headers = {
        "Strict-Transport-Security": (
            r"strict-transport-security:\s*max-age=31536000;\s*includeSubDomains",
        ),
        "X-Content-Type-Options": (r"x-content-type-options:\s*nosniff",),
        "X-Frame-Options": (r"x-frame-options:\s*DENY",),
        "Referrer-Policy": (r"referrer-policy:\s*no-referrer",),
        "Content-Security-Policy": (
            r"\^content-security-policy:",
            r"connect-src\s+'self'\s+https://\$\{API_DOMAIN\}",
        ),
    }
    for scope, section, capture_pattern in response_header_smokes:
        if not re.search(capture_pattern, section, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits actual {scope} response-header capture")
        for header, patterns in reviewed_response_headers.items():
            if not all(
                re.search(pattern, section, re.MULTILINE | re.IGNORECASE)
                for pattern in patterns
            ):
                errors.append(
                    f"production CD omits the {header} check on actual {scope} responses"
                )

    rollback_smoke = marker_section(
        "Roll back production Amplify branch after failed release",
        "Summarize immutable production release",
    )
    rollback_patterns = {
        (
            r"API_COMPATIBILITY:\s*\$\{\{\s*"
            r"steps\.api_transition\.outputs\.compatibility\s*\}\}"
        ): "the captured API compatibility state in rollback smoke",
        (
            r'for\s+base_url\s+in\s+"\$production_url"\s+'
            r'"https://\$\{PROD_DOMAIN\}"'
        ): "both Amplify frontend domains in rollback smoke",
        r'"\$\{base_url\}/"': "frontend root availability in rollback smoke",
        r'"\$\{base_url\}/release\.json"': (
            "frontend release identity in rollback smoke"
        ),
        (
            r"for\s+path\s+in\s+/health/live\s+/health\s+/admin/\s+"
            r"/static/admin/css/base\.css"
        ): "direct API health, admin, and admin-static checks in rollback smoke",
        r'"https://\$\{API_DOMAIN\}\$\{path\}"': (
            "the API subdomain boundary in rollback smoke"
        ),
        (
            r'if\s+\[\s*"\$API_COMPATIBILITY"\s*=\s*"true"\s*\]\s*;\s*then'
        ): "the transitional compatibility branch in rollback smoke",
        r"for\s+path\s+in\s+/api/health/live\s+/api/health\s+/admin/": (
            "transitional frontend compatibility checks in rollback smoke"
        ),
        r"for\s+path\s+in\s+/api/health\s+/admin/": (
            "retired frontend backend-route checks in rollback smoke"
        ),
        r'status"\s*!=\s*"404"': (
            "404 enforcement for retired frontend backend routes in rollback smoke"
        ),
    }
    for pattern, description in rollback_patterns.items():
        if not re.search(pattern, rollback_smoke, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description}")
    rollback_deadline_patterns = {
        r"phase_deadline=\$\(\(SECONDS\s*\+\s*300\)\)": (
            "a 300-second hard deadline in rollback smoke"
        ),
        r"bounded_curl\(\)": "the deadline-aware rollback curl wrapper",
        r"remaining=\$\(\(phase_deadline\s*-\s*SECONDS\)\)": (
            "per-request remaining-time calculation in rollback smoke"
        ),
        r'if\s+\[\s*"\$remaining"\s*-le\s*0\s*\]\s*;\s*then': (
            "fail-closed exhausted-deadline handling in rollback smoke"
        ),
        r'timeout\s+--signal=TERM\s+"\$\{remaining\}s"\s+curl\s+"\$@"': (
            "an operating-system-enforced rollback curl deadline"
        ),
        r"if\s+\(\(SECONDS\s*>=\s*phase_deadline\)\)\s*;\s*then": (
            "deadline enforcement inside rollback convergence polling"
        ),
    }
    for pattern, description in rollback_deadline_patterns.items():
        if not re.search(pattern, rollback_smoke, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description}")
    if re.search(
        r"for\s+path\s+in\s+/\s+/api/health/live\s+/api/health\s+/admin/",
        rollback_smoke,
    ):
        errors.append(
            "production CD mixes backend routes into the rollback frontend smoke loop"
        )

    final_plan = marker_section(
        "Plan final production topology",
        "Apply exact final production topology plan",
    )
    final_plan_patterns = {
        r"unexpected_changes=": "an unexpected_changes result",
        r"\.resource_changes\[\]\?": "all final-plan resource changes",
        r'select\(\.change\.actions\s*!=\s*\["no-op"\]\)': (
            "no-op filtering in the final-plan allowlist"
        ),
        r"def\s+backend_proxy_source:": "the exact retired backend proxy-rule scope",
        r"def\s+reviewed_backend_rule:": (
            "validation of the retired backend proxy-rule shape"
        ),
        r"def\s+prune_unknown:": "fail-closed unknown-value normalization",
        r"del\(\.custom_rule\)": "a custom-rule-only Amplify app update",
        r'\.\s*==\s*"/api"': "retired Amplify API-rule rejection",
        r'\.\s*==\s*"/authn"': "retired Amplify auth-rule rejection",
        r'\.\s*==\s*"/admin"': "retired Amplify admin-rule rejection",
        r'\.\s*==\s*"/static"': "retired Amplify static-rule rejection",
        r"starts_with|startswith": "retired Amplify proxy-rule prefix rejection",
        r'\.target\s*\|\s*startswith\(\$legacy_origin_url\s*\+\s*"/"\)': (
            "the exact retired backend proxy target"
        ),
        r'\.status\s*==\s*"200"': "the exact retired backend proxy status",
        r"\.change\.after_unknown[\s\S]{0,150}prune_unknown": (
            "unknown-value rejection in the final-plan allowlist"
        ),
        r"del\(\.ecs_target\[0\]\.task_definition_arn\)": (
            "a task-definition-only reminder target update"
        ),
        r"del\(\.task_definition\)": "task-definition-only ECS service updates",
        r"del\(\.health_check\[0\]\.path\)": (
            "health-path-only backend target-group update"
        ),
        r'\.change\.before\.health_check\[0\]\.path\s*!=\s*"/api/health"': (
            "the exact retired target-group health path"
        ),
        r'\.change\.after\.health_check\[0\]\.path\s*!=\s*"/health"': (
            "the exact final target-group health path"
        ),
        r"def\s+normalized_task:": "normalized task-definition comparison",
        r"def\s+normalized_backend_container:": (
            "normalized backend container comparison"
        ),
        r"def\s+normalized_frontend_container:": (
            "normalized frontend container comparison"
        ),
        r"def\s+backend_final_values_are_safe:": (
            "backend final-value safety validation"
        ),
        r"def\s+frontend_final_values_are_safe:": (
            "frontend final-value safety validation"
        ),
        r'ENABLE_LEGACY_API_PREFIX\s*==\s*"0"': (
            "disabled legacy API prefix in the final backend task"
        ),
        r"BACKEND_URL\s*==\s*\$api_url": (
            "the API subdomain in final task definitions"
        ),
        r"aws\s+sts\s+get-caller-identity\s+--query\s+Account": (
            "the AWS account ID used to construct the reviewed frontend image"
        ),
        (
            r'expected_frontend_image="\$\{account_id\}\.dkr\.ecr\.'
            r"\$\{AWS_REGION\}\.amazonaws\.com/\$\{ECR_FRONTEND\}:"
            r'\$\{DEPLOY_SHA\}"'
        ): "the exact immutable frontend ECR image URI",
        r'--arg\s+frontend_image\s+"\$expected_frontend_image"': (
            "the exact frontend ECR image passed to final-plan review"
        ),
        r"\$container\.image\s*==\s*\$frontend_image": (
            "exact frontend image equality in the final task"
        ),
        r'\$actions\s*!=\s*\["update"\]': "update-only mutable final resources",
        r'\(\$actions\s*\|\s*sort\)\s*!=\s*\["create",\s*"delete"\]': (
            "create-delete-only task-definition replacement"
        ),
        r'\$actions\s*!=\s*\["delete"\]': ("delete-only transitional resource removal"),
        r"else\s+true\s+end": "fail-closed rejection of unreviewed final changes",
        r'if\s+\[\s*"\$unexpected_changes"\s*!=\s*"\[\]"\s*\]\s*;\s*then': (
            "fail-closed enforcement of unexpected final changes"
        ),
    }
    for pattern, description in final_plan_patterns.items():
        if not re.search(pattern, final_plan, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description}")
    if re.search(r"endswith\(\$frontend_image", final_plan):
        errors.append(
            "production CD retains suffix-only frontend image validation in the final plan"
        )

    expected_final_plan_addresses = {
        "aws_amplify_app.frontend",
        "aws_cloudwatch_event_target.event_reminders",
        "aws_ecs_service.backend",
        "aws_ecs_service.frontend",
        "aws_lb_target_group.backend",
        "aws_ecs_task_definition.backend",
        "aws_ecs_task_definition.frontend",
        "aws_acm_certificate.origin[0]",
        "aws_acm_certificate_validation.origin[0]",
        "aws_lb_listener_certificate.origin[0]",
        "aws_lb_listener_rule.backend[0]",
        "aws_route53_record.origin[0]",
        "aws_route53_record.origin_cert_validation[",
    }
    actual_final_plan_addresses = set(
        re.findall(r'"(aws_[a-z0-9_.\[\]]+)"', final_plan)
    )
    if actual_final_plan_addresses != expected_final_plan_addresses:
        errors.append(
            "production CD final plan does not use the exact reviewed "
            "unexpected_changes address allowlist"
        )

    final_verification = marker_section(
        "Verify final API-only backend topology",
        "Restore pre-release canonical Route53 alias after failed first cutover",
    )
    final_runtime_patterns = {
        r"aws\s+sts\s+get-caller-identity\s+--query\s+Account": (
            "the AWS account ID used for final runtime identity checks"
        ),
        (
            r'expected_backend_image="\$\{account_id\}\.dkr\.ecr\.'
            r"\$\{AWS_REGION\}\.amazonaws\.com/\$\{ECR_BACKEND\}:"
            r'\$\{DEPLOY_SHA\}"'
        ): "the exact immutable backend ECR image URI in final verification",
        (
            r'expected_frontend_image="\$\{account_id\}\.dkr\.ecr\.'
            r"\$\{AWS_REGION\}\.amazonaws\.com/\$\{ECR_FRONTEND\}:"
            r'\$\{DEPLOY_SHA\}"'
        ): "the exact immutable frontend ECR image URI in final verification",
        (
            r'backend_task_definition="\$\([\s\S]{0,700}'
            r'--services\s+"\$\{\{\s*steps\.terraform\.outputs\.backend_service'
            r'\s*\}\}"[\s\S]{0,300}'
            r'--query\s+"services\[0\]\.taskDefinition"'
        ): "the backend service task-definition discovery",
        (
            r'expected_backend_task_definition="\$\([\s\S]{0,300}'
            r"terraform\s+-chdir=infra/prod\s+output\s+-raw\s+"
            r"backend_task_definition_arn"
        ): "the Terraform-selected backend task definition",
        (
            r'if\s+\[\s*"\$backend_task_definition"\s*!=\s*'
            r'"\$expected_backend_task_definition"\s*\]\s*;\s*then'
        ): "exact backend service task-definition equality",
        (
            r'backend_image="\$\([\s\S]{0,300}'
            r'--task-definition\s+"\$backend_task_definition"'
            r"[\s\S]{0,300}--query\s+"
            r'"taskDefinition\.containerDefinitions\[0\]\.image"'
        ): "the deployed backend image discovery",
        (
            r'if\s+\[\s*"\$backend_image"\s*!=\s*'
            r'"\$expected_backend_image"\s*\]\s*;\s*then'
        ): "exact backend runtime image equality",
        (
            r'frontend_task_definition="\$\([\s\S]{0,700}'
            r'--services\s+"\$\{\{\s*steps\.terraform\.outputs\.frontend_service'
            r'\s*\}\}"[\s\S]{0,300}'
            r'--query\s+"services\[0\]\.taskDefinition"'
        ): "the frontend service task-definition discovery",
        (
            r'expected_frontend_task_definition="\$\([\s\S]{0,300}'
            r"terraform\s+-chdir=infra/prod\s+output\s+-raw\s+"
            r"frontend_task_definition_arn"
        ): "the Terraform-selected frontend task definition",
        (
            r'if\s+\[\s*"\$frontend_task_definition"\s*!=\s*'
            r'"\$expected_frontend_task_definition"\s*\]\s*;\s*then'
        ): "exact frontend service task-definition equality",
        (
            r'frontend_image="\$\([\s\S]{0,300}'
            r'--task-definition\s+"\$frontend_task_definition"'
            r"[\s\S]{0,300}--query\s+"
            r'"taskDefinition\.containerDefinitions\[0\]\.image"'
        ): "the deployed frontend image discovery",
        (
            r'if\s+\[\s*"\$frontend_image"\s*!=\s*'
            r'"\$expected_frontend_image"\s*\]\s*;\s*then'
        ): "exact frontend runtime image equality",
        (
            r'event_targets="\$\([\s\S]{0,300}'
            r"aws\s+events\s+list-targets-by-rule[\s\S]{0,300}"
            r"--output\s+json"
        ): "complete reminder target-set discovery",
        (
            r"if\s+!\s+jq\s+-e[\s\S]{0,200}"
            r'--arg\s+expected\s+"\$expected_backend_task_definition"'
        ): "the expected backend task definition in reminder-target validation",
        r"\(\.Targets\s*\|\s*length\)\s*==\s*1": (
            "exactly one EventBridge reminder target"
        ),
        (
            r"\.Targets\[0\]\.EcsParameters\.TaskDefinitionArn"
            r"\s*==\s*\$expected"
        ): "exact reminder-target backend task-definition ARN equality",
        r'<<<"\$event_targets"\s*>\s*/dev/null': (
            "the complete reminder target set in fail-closed validation"
        ),
    }
    for pattern, description in final_runtime_patterns.items():
        if not re.search(pattern, final_verification, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description}")

    preflight_smokes = (
        ("production branch pre-cutover", production_branch_smoke, "canonical"),
        ("canonical post-cutover", canonical_smoke, "canonical"),
        ("final API topology", final_verification, "final"),
    )
    for scope, section, prefix in preflight_smokes:
        preflight_patterns = {
            rf'{prefix}_preflight_headers="\$\{{RUNNER_TEMP\}}/': (
                "an isolated response-header capture"
            ),
            rf'{prefix}_preflight_status="\$\(': "the HTTP preflight status capture",
            r"--request\s+OPTIONS": "an OPTIONS request",
            r'--header\s+"Origin:\s*https://\$\{PROD_DOMAIN\}"': (
                "the canonical frontend origin"
            ),
            r'--header\s+"Access-Control-Request-Method:\s*PUT"': (
                "the protected PUT request method"
            ),
            (
                r'--header\s+"Access-Control-Request-Headers:\s*'
                r'authorization,content-type"'
            ): "the credentialed request headers",
            rf'--dump-header\s+"\${prefix}_preflight_headers"': (
                "actual preflight response-header capture"
            ),
            r'--write-out\s+"%\{http_code\}"': "the preflight HTTP status",
            r'"https://\$\{API_DOMAIN\}/authn/profile/"': (
                "the direct API protected endpoint"
            ),
            (
                rf'if\s+\[\s*"\${prefix}_preflight_status"\s*!=\s*'
                r'"200"\s*\]\s*\|\|'
            ): "fail-closed HTTP 200 enforcement",
            r"access-control-allow-origin:\s*https://\$\{PROD_DOMAIN\}": (
                "exact canonical Access-Control-Allow-Origin enforcement"
            ),
            r"access-control-allow-credentials:[^\n]*true": (
                "credentialed CORS enforcement"
            ),
        }
        for pattern, description in preflight_patterns.items():
            if not re.search(pattern, section, re.MULTILINE | re.IGNORECASE):
                errors.append(
                    f"production CD omits {description} in {scope} CORS preflight"
                )

    stable_retirement_patterns = {
        r"legacy_urls=\(": "the complete retired-route URL set",
        r"for\s+attempt\s+in\s+\$\(seq\s+1\s+30\)": (
            "a bounded retired-route convergence window"
        ),
        r'for\s+legacy_url\s+in\s+"\$\{legacy_urls\[@\]\}"': (
            "every retired route in each stability cycle"
        ),
        r"https://\$\{PROD_DOMAIN\}/api/health": "the retired frontend API route",
        r"https://\$\{PROD_DOMAIN\}/admin/": "the retired frontend admin route",
        r"https://\$\{PROD_DOMAIN\}/authn/public-key/": (
            "the retired frontend auth route"
        ),
        r"https://\$\{PROD_DOMAIN\}/static/admin/css/base\.css": (
            "the retired frontend backend-static route"
        ),
        r"https://\$\{API_DOMAIN\}/api/health": "the retired API prefix",
        r"stable_retired_cycles=0": "retired-route stability tracking",
        r"all_retired=true": "an all-routes-retired cycle guard",
        r'status"\s*!=\s*"404"': "404-only retired-route acceptance",
        r"all_retired=false": "failed-cycle retirement tracking",
        r"stable_retired_cycles=\$\(\(stable_retired_cycles \+ 1\)\)": (
            "consecutive retired-route cycle counting"
        ),
        r'stable_retired_cycles"\s*-ge\s*3': (
            "three-cycle retired-route stability threshold"
        ),
        r'stable_retired_cycles"\s*-lt\s*3': (
            "fail-closed retired-route stability enforcement"
        ),
        r"Cache-Control:\s*no-cache": "cache bypass on retired-route checks",
        r"Pragma:\s*no-cache": "legacy cache bypass on retired-route checks",
        r"retired_check=\$\{DEPLOY_SHA\}-\$\{attempt\}": (
            "per-cycle retired-route cache busting"
        ),
    }
    for pattern, description in stable_retirement_patterns.items():
        if not re.search(pattern, final_verification, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description}")
    if final_verification.count("stable_retired_cycles=0") < 2:
        errors.append(
            "production CD does not reset retired-route stability after a non-404 cycle"
        )
    retired_status_position = final_verification.find('if [ "$status" != "404" ]')
    retired_increment_position = final_verification.find(
        "stable_retired_cycles=$((stable_retired_cycles + 1))"
    )
    retired_reset_position = final_verification.rfind("stable_retired_cycles=0")
    if not (
        0
        <= retired_status_position
        < retired_increment_position
        < retired_reset_position
    ):
        errors.append(
            "production CD does not require a complete 404 cycle before "
            "advancing retired-route stability"
        )

    compensation = marker_section(
        "Restore pre-release canonical Route53 alias after failed first cutover",
        "Roll back production Amplify branch after failed release",
    )
    compensation_patterns = {
        r"association_terminal=false": "Amplify association terminal-state tracking",
        r"aws\s+amplify\s+get-domain-association": (
            "Amplify association polling before DNS compensation"
        ),
        r"\.domainAssociation\.domainStatus": "Amplify domain-status inspection",
        r"\.domainAssociation\.updateStatus": "Amplify update-status inspection",
        r"AVAILABLE": "successful Amplify association terminal status",
        r"UPDATE_COMPLETE": "completed Amplify association update status",
        r"UPDATE_FAILED": "failed Amplify association update status",
        r"FAILED": "failed Amplify domain terminal status",
        r"NotFoundException": "removed Amplify association terminal status",
        r"association_terminal=true": "confirmed Amplify association termination",
        (
            r'domain_status"\s*=\s*"AVAILABLE"[\s\S]{0,250}'
            r'update_status"\s*=~\s*\^\(NONE\|UPDATE_COMPLETE\)\$'
        ): "the successful Amplify association terminal-state pair",
        r'update_status"\s*=\s*"UPDATE_FAILED"': (
            "the failed Amplify update terminal state"
        ),
        (
            r'domain_status"\s*=\s*"FAILED"[\s\S]{0,150}'
            r'update_status"\s*=\s*"NONE"'
        ): "the failed Amplify domain terminal-state pair",
        r"NotFoundException[\s\S]{0,150}association_terminal=true": (
            "the absent Amplify association terminal state"
        ),
        r'association_terminal"\s*!=\s*"true"': (
            "fail-closed Amplify association terminal-state enforcement"
        ),
        r"stable_alias_checks=0": "DNS compensation stability tracking",
        r"stable_alias_checks=\$\(\(stable_alias_checks \+ 1\)\)": (
            "consecutive DNS compensation stability counting"
        ),
        r'stable_alias_checks"\s*-ge\s*6': (
            "six-check DNS compensation stability threshold"
        ),
        r'stable_alias_checks"\s*-lt\s*6': (
            "fail-closed DNS compensation stability enforcement"
        ),
        r"restore_canonical_alias": "repeatable authoritative alias restoration",
        (
            r'actual_alias"\s*=\s*"\$expected_alias"[\s\S]{0,250}'
            r"stable_alias_checks=\$\(\(stable_alias_checks \+ 1\)\)"
        ): "stable alias counting only after an exact restored-alias match",
        (
            r"elif\s+is_recognized_amplify_alias[\s\S]{0,350}"
            r"restore_canonical_alias[\s\S]{0,150}stable_alias_checks=0"
        ): "stability reset after an Amplify alias rewrite",
    }
    for pattern, description in compensation_patterns.items():
        if not re.search(pattern, compensation, re.MULTILINE | re.DOTALL):
            errors.append(f"production CD omits {description}")
    if compensation.count("stable_alias_checks=0") < 2:
        errors.append(
            "production CD does not reset DNS compensation stability after an alias rewrite"
        )
    terminal_position = compensation.find("association_terminal=false")
    restore_position = compensation.find("restore_canonical_alias")
    if (
        terminal_position < 0
        or restore_position < 0
        or terminal_position > restore_position
    ):
        errors.append(
            "production CD restores DNS before Amplify association activity is terminal"
        )

    final_steps = (
        (
            "Plan final production topology",
            "Apply exact final production topology plan",
        ),
        (
            "Apply exact final production topology plan",
            "Verify final API-only backend topology",
        ),
        (
            "Verify final API-only backend topology",
            "Restore pre-release canonical Route53 alias after failed first cutover",
        ),
    )
    for marker, next_marker in final_steps:
        section = marker_section(marker, next_marker)
        if re.search(r"(?m)^[ \t]*if\s*:", section):
            errors.append(f"production CD conditionally skips {marker}")

    if source.count("jq -r '.static_routes[]'") < 2:
        errors.append(
            "production CD omits all exported routes from candidate or production branch smokes"
        )
    if source.count("find src/frontend/out/_next/static") < 2:
        errors.append(
            "production CD omits a deployed static asset from candidate or production branch smokes"
        )
    if source.count("terraform -chdir=infra/prod untaint") < 1:
        errors.append(
            "production CD omits verified tainted-domain recovery during detection"
        )
    if source.count('.change.actions | index("delete")) == null') < 1:
        errors.append("production CD omits a no-destroy gate for domain cutover")
    if source.count("amplify-apex-target.sh") < 3:
        errors.append(
            "production CD must use the shared Amplify apex-target parser during "
            "preflight, cutover, and failure compensation"
        )

    forbidden_patterns = {
        r"TF_VAR_manage_dns": "legacy DNS-disable cutover flow",
        r"amplify [^\n]*(?:--repository|access-token)": (
            "a Git repository or access-token connection"
        ),
        r"amplify delete-domain-association": (
            "a destructive automated Amplify domain disassociation"
        ),
        r"amplify\s+start-job|--job-type\s+RETRY": (
            "unsupported Amplify StartJob retry rollback"
        ),
        r"origin_restricted_to_cloudfront": (
            "retired CloudFront origin-restriction state detection"
        ),
        r"trust_cloudfront_proxy_chain": (
            "retired CloudFront proxy-chain state detection"
        ),
        r"TF_VAR_restrict_origin_to_cloudfront": (
            "retired CloudFront origin-hardening input"
        ),
        r"TF_VAR_trust_cloudfront_proxy_chain": (
            "retired CloudFront proxy-chain input"
        ),
        r"An ALB canonical alias requires public ingress and one-hop proxy trust": (
            "retired CloudFront fallback state coupling"
        ),
        r"Allow legacy Route53 alias caches to expire": (
            "retired CloudFront hardening delay"
        ),
        r"Plan CloudFront-only origin hardening": (
            "retired CloudFront-only origin hardening"
        ),
        r"Verify production through the CloudFront-only origin": (
            "retired CloudFront-only origin verification"
        ),
        r"Plan trusted CloudFront proxy chain": (
            "retired CloudFront proxy-chain rollout"
        ),
        r"Wait for trusted-proxy backend rollout": (
            "retired trusted-proxy backend rollout"
        ),
        r"Verify trusted-proxy backend target health": (
            "retired trusted-proxy backend verification"
        ),
        r"Verify production through the trusted CloudFront proxy chain": (
            "retired trusted CloudFront proxy verification"
        ),
        r"Restore pre-release origin safety state after failure": (
            "retired CloudFront origin-safety restoration"
        ),
        r"production-restore-origin\.tfplan|steps\.restore_origin_safety": (
            "retired CloudFront origin-safety restore state"
        ),
        r"terraform [^\n]* state rm": "destructive automated Terraform state removal",
        r"terraform [^\n]* -replace": "an automated forced resource replacement",
        r"terraform [^\n]* taint": "automated resource tainting",
    }
    for pattern, description in forbidden_patterns.items():
        if re.search(pattern, source, re.MULTILINE | re.IGNORECASE):
            errors.append(f"production CD retains {description}")

    ordered_markers = (
        "Capture pre-release canonical Route53 alias",
        "Guard live Amplify configuration before candidate smoke",
        "Fail closed when an Amplify release job is active",
        "Capture current Amplify production rollback point",
        "Resolve retained Amplify rollback artifact",
        "Download retained Amplify rollback artifact",
        "Verify retained Amplify rollback artifact",
        "Deploy candidate Amplify branch",
        "Smoke candidate Amplify frontend and direct API boundary",
        "Require a safe live-branch mutation budget",
        "Deploy production Amplify branch",
        "Smoke production Amplify branch before domain cutover",
        "Verify preserved canonical alias immediately before cutover",
        "Plan reviewed Amplify domain association",
        "Require a safe first-cutover time budget",
        "Apply exact Amplify domain association plan",
        "Reconcile Amplify domain association for a migration retry",
        "Wait for Amplify custom domain availability",
        "Verify Amplify canonical DNS cutover",
        "Run canonical production smoke tests",
        "Plan final production topology",
        "Apply exact final production topology plan",
        "Verify final API-only backend topology",
        "Restore pre-release canonical Route53 alias after failed first cutover",
        "Roll back production Amplify branch after failed release",
    )
    positions = [source.find(marker) for marker in ordered_markers]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        errors.append(
            "production CD must resolve and verify rollback artifacts before "
            "candidate, production, and custom-domain stages"
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
        r"--connect-timeout": "a bounded presigned-upload connection",
        r"--max-time": "a bounded presigned upload",
        r"--retry-max-time": "a bounded presigned-upload retry window",
        r"AMPLIFY_UPLOAD_CONNECT_TIMEOUT_SECONDS": (
            "a configurable presigned-upload connection timeout"
        ),
        r"AMPLIFY_UPLOAD_MAX_TIME_SECONDS": (
            "a configurable presigned-upload maximum time"
        ),
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
        r'stop_attempts="\$\{AMPLIFY_STOP_ATTEMPTS:-5\}"': (
            "five bounded cancellation attempts"
        ),
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
        errors.append(
            "production Terraform omits ALB security-group destroy protection"
        )
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
        errors.append(
            "production Terraform must set AUTH_TRUSTED_PROXY_COUNT exactly once to 1"
        )

    forbidden_patterns = {
        r"com\.amazonaws\.global\.cloudfront\.origin-facing": (
            "the retired AWS-managed CloudFront origin prefix list"
        ),
        r"(?:var\.)?restrict_origin_to_cloudfront": (
            "the retired CloudFront-only origin gate"
        ),
        r"(?:var\.)?trust_cloudfront_proxy_chain": (
            "the retired trusted CloudFront proxy-chain gate"
        ),
        r"AUTH_TRUSTED_PROXY_CIDRS": ("the retired CloudFront CIDR runtime allowlist"),
        r"AUTH_TRUSTED_PROXY_CIDR_HOPS": (
            "the retired CIDR-verified proxy-hop configuration"
        ),
        r"cloudfront_origin_facing\.entries": (
            "the retired CloudFront prefix-list CIDR expansion"
        ),
    }
    for pattern, description in forbidden_patterns.items():
        if re.search(pattern, terraform_source):
            errors.append(f"production Terraform retains {description}")
    return errors


def production_amplify_custom_headers_policy_errors(source: str) -> list[str]:
    """Require the reviewed policy shape accepted by Amplify's customHeaders API."""

    try:
        payload = json.loads(source)
    except json.JSONDecodeError:
        return ["production Amplify custom-header policy is not valid JSON"]

    if not isinstance(payload, dict):
        return [
            "production Amplify custom-header policy must be a top-level JSON object"
        ]
    if not isinstance(payload.get("customHeaders"), list):
        return [
            "production Amplify custom-header policy omits the top-level customHeaders list"
        ]
    return []


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
        (
            r'\{\s*name\s*=\s*"AUTH_TRUSTED_PROXY_COUNT"\s*,'
            r'\s*value\s*=\s*"1"\s*\}'
        ): "one-hop public ALB proxy trust",
        r'xff_header_processing_mode\s*=\s*"append"': "explicit ALB XFF append mode",
        r"enable_xff_client_port\s*=\s*false": "port-free ALB XFF addresses",
        r"amplify-routes\.json": "a shared Amplify static route manifest",
        r"amplify-custom-headers\.json": "a reviewed Amplify security-header policy",
        r'resource\s+"aws_route53_record"\s+"api"': "an API-domain ALB alias",
        r'resource\s+"aws_lb_listener_certificate"\s+"api"': (
            "an API-domain ALB certificate"
        ),
        r'resource\s+"aws_lb_listener_rule"\s+"backend_api_host"': (
            "host-wide API-domain backend routing"
        ),
        r"enable_legacy_api_compatibility": (
            "a bounded first-release compatibility switch"
        ),
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
    errors.extend(production_amplify_custom_headers_errors(production_terraform))

    bootstrap_terraform = (root / BOOTSTRAP_TERRAFORM.relative_to(ROOT)).read_text(
        encoding="utf-8"
    )
    for pattern, description in {
        r'backend\s+"s3"\s*\{\s*\}': "an S3 backend declaration for migrated bootstrap state",
        r"existing_github_oidc_provider_arn": "an explicit shared GitHub OIDC provider input",
        r"from\s*=\s*aws_iam_openid_connect_provider\.github": "a non-destructive legacy OIDC state removal",
        r"destroy\s*=\s*false": "a shared OIDC provider preservation guard",
        r'"route53:ListHostedZones"': (
            "the observed Amplify Route53 hosted-zone discovery permission"
        ),
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
