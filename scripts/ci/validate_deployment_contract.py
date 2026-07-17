#!/usr/bin/env python3
"""Keep runtime requirements, Terraform, and deployment workflows aligned."""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PRODUCTION_SETTINGS = ROOT / "backend/src/config/settings/production.py"
TERRAFORM_ENVIRONMENTS = {
    "staging": ROOT / "infra/staging/main.tf",
    "production": ROOT / "infra/prod/main.tf",
}
DEPLOY_WORKFLOWS = {
    "staging": ROOT / ".github/workflows/deploy-staging.yml",
    "production": ROOT / ".github/workflows/deploy-prod.yml",
}
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

    workflow_text = {
        name: (root / path.relative_to(ROOT)).read_text(encoding="utf-8")
        for name, path in DEPLOY_WORKFLOWS.items()
    }
    for environment, text in workflow_text.items():
        lower = text.lower()
        if "continue-on-error" in text:
            errors.append(f"{environment} deploy workflow allows errors to continue")
        if "local backend fallback" in lower or "backend_mode=local" in lower:
            errors.append(
                f"{environment} deploy workflow permits local Terraform state"
            )
        if re.search(r"(?:staging|prod)-latest", lower):
            errors.append(f"{environment} deploy workflow uses a mutable image tag")
        expected_name = "Staging" if environment == "staging" else "Production"
        if not re.search(rf"environment:\s*\n\s+name:\s*{expected_name}\b", text):
            errors.append(
                f"{environment} deploy workflow is not bound to {expected_name}"
            )
        if "use_lockfile=true" not in text:
            errors.append(
                f"{environment} deploy workflow does not enable S3 state locking"
            )

    production_workflow = workflow_text["production"]
    for required_fragment in (
        "workflow_dispatch:",
        "role-to-assume:",
        "production.tfplan",
        "refs/heads/main",
        "CI Result",
    ):
        if required_fragment not in production_workflow:
            errors.append(f"production deploy workflow omits {required_fragment}")
    for forbidden_fragment in (
        "workflow_run:",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
    ):
        if forbidden_fragment in production_workflow:
            errors.append(
                f"production deploy workflow contains forbidden {forbidden_fragment}"
            )

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
    }
    for pattern, description in production_invariants.items():
        if not re.search(pattern, production_terraform):
            errors.append(f"production Terraform omits {description}")

    return errors


def main() -> int:
    errors = deployment_contract_errors()
    if errors:
        print("Deployment contract validation failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print(
        "Deployment workflows provide every required production setting and safety invariant."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
