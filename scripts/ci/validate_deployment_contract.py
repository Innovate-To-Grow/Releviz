#!/usr/bin/env python3
"""Keep runtime requirements, Terraform, and deployment workflows aligned."""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PRODUCTION_SETTINGS = ROOT / "backend/src/config/settings/production.py"
BOOTSTRAP_TERRAFORM = ROOT / "infra/bootstrap/main.tf"
TERRAFORM_ENVIRONMENTS = {
    "production": ROOT / "infra/prod/main.tf",
}
PRODUCTION_DEPLOY_WORKFLOW = ROOT / ".github/workflows/deploy-prod.yml"
DISABLED_PRODUCTION_DEPLOY_WORKFLOW = (
    ROOT / ".github/workflows/deploy-prod.yml.disabled"
)
CD_DISABLED_MARKER = "CD_DISABLED_DURING_PR_CONSOLIDATION"
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


def production_cd_disabled_errors(root: Path = ROOT) -> list[str]:
    """Ensure production CD remains non-runnable during PR consolidation."""

    errors: list[str] = []
    active_path = root / PRODUCTION_DEPLOY_WORKFLOW.relative_to(ROOT)
    disabled_path = root / DISABLED_PRODUCTION_DEPLOY_WORKFLOW.relative_to(ROOT)
    if active_path.exists():
        errors.append("production CD must remain disabled during PR consolidation")
    if not disabled_path.exists():
        errors.append("disabled production CD marker file is missing")
        return errors
    if CD_DISABLED_MARKER not in disabled_path.read_text(encoding="utf-8"):
        errors.append("disabled production CD marker file omits its safety marker")
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

    errors.extend(production_cd_disabled_errors(root))

    for relative_path in RETIRED_STAGING_PATHS:
        if (root / relative_path).exists():
            errors.append(f"retired staging path remains: {relative_path}")

    production_terraform = (
        root / TERRAFORM_ENVIRONMENTS["production"].relative_to(ROOT)
    ).read_text(encoding="utf-8")
    production_invariants = {
        r'resource\s+"aws_ecs_service"\s+"backend"': "a backend ECS service",
        r'resource\s+"aws_ecs_service"\s+"frontend"': "a frontend ECS service",
        r"assign_public_ip\s*=\s*false": "private ECS networking",
        r"multi_az\s*=\s*true": "Multi-AZ PostgreSQL",
        r"manage_master_user_password\s*=\s*true": "an RDS-managed database password",
        r"deployment_circuit_breaker\s*\{": "ECS automatic rollback",
        r"alarm_actions\s*=\s*var\.alarm_action_arns": "monitored alarm actions",
        r"count\s*=\s*var\.manage_dns\s*\?\s*1\s*:\s*0": "health-gated DNS",
        r"allow_overwrite\s*=\s*true": "explicit apex alias replacement",
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
    print("Production CD is disabled and Terraform retains its safety invariants.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
