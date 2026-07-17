import subprocess
from pathlib import Path

from django.test import SimpleTestCase

ROOT = Path(__file__).resolve().parents[5]

RESOURCE_AUDIT_MANIFEST = [
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-staging.yml",
    ".gitignore",
    ".pre-commit-config.yaml",
    ".prettierignore",
    ".prettierrc",
    "README.md",
    "Screenshoot.png",
    "backend/Dockerfile",
    "backend/docker-entrypoint.sh",
    "backend/package.json",
    "backend/pyproject.toml",
    "backend/requirements/base.txt",
    "backend/requirements/local.txt",
    "backend/requirements/production.txt",
    "backend/src/apps/core/static/admin/css/file-input.css",
    "backend/src/apps/core/static/admin/css/google-material-admin-overrides.css",
    "backend/src/apps/core/static/admin/css/google-material-admin.css",
    "backend/src/apps/core/static/admin/css/tabs.css",
    "backend/src/apps/core/static/admin/js/i2g-admin-theme-runtime.js",
    "backend/src/apps/core/static/admin/js/material-web-text-field.js",
    "backend/src/apps/core/static/images/scheduler-logo.svg",
    "backend/src/apps/core/templates/admin/base_site.html",
    "backend/src/apps/core/templates/admin/includes/i2g_admin_theme_toggle.html",
    "backend/src/apps/core/templates/admin/includes/itg_login_styles.html",
    "backend/src/apps/core/templates/admin/index.html",
    "backend/src/apps/core/templates/admin/login.html",
    "backend/src/apps/core/templates/unfold/helpers/navigation_header.html",
    "backend/src/apps/core/templates/unfold/helpers/site_branding.html",
    "backend/src/apps/core/templates/unfold/helpers/site_logo.html",
    "backend/src/apps/core/templates/unfold/helpers/theme_switch_dropdown.html",
    "backend/src/apps/core/templates/unfold/helpers/userlinks.html",
    "docker-compose.e2e.yml",
    "docs/auth-security.md",
    "docs/backup-restore.md",
    "docs/deployment-rollback.md",
    "docs/email-delivery.md",
    "docs/observability.md",
    "docs/product-analytics.md",
    "docs/real-user-validation-plan.md",
    "docs/releviz-goal-progress.md",
    "docs/scheduling-slots.md",
    "e2e/accessibility.spec.js",
    "e2e/helpers/accessibility.js",
    "e2e/playwright.config.js",
    "frontend/.prettierignore",
    "frontend/.dockerignore",
    "frontend/@next/package.json",
    "frontend/Dockerfile",
    "frontend/app/globals.css",
    "frontend/eslint.config.mjs",
    "frontend/jest.config.js",
    "frontend/jsconfig.json",
    "frontend/next.config.js",
    "frontend/package-lock.docker.json",
    "frontend/package.json",
    "frontend/public/favicon.ico",
    "frontend/public/homepage.png",
    "frontend/public/img/i2glogo.png",
    "frontend/public/img/ucmlogo.png",
    "frontend/public/logo192.png",
    "frontend/public/logo512.png",
    "frontend/public/robots.txt",
    "infra/bootstrap/main.tf",
    "infra/prod/main.tf",
    "infra/prod/outputs.tf",
    "infra/prod/tests/plan.tftest.hcl",
    "infra/prod/variables.tf",
    "infra/prod/versions.tf",
    "infra/staging/main.tf",
    "infra/staging/outputs.tf",
    "infra/staging/tests/plan.tftest.hcl",
    "infra/staging/variables.tf",
    "infra/staging/versions.tf",
    "package-lock.json",
    "package.json",
    "scripts/quality-gate.sh",
    "scripts/backup-restore-drill.sh",
    "scripts/ci/check_bundle_size.py",
    "scripts/ci/check_npm_licenses.py",
    "scripts/ci/plan_django_tests.py",
    "scripts/ci/plan_e2e_tests.py",
    "scripts/ci/summarize_workflow_jobs.py",
    "scripts/ci/validate_dependabot_labels.py",
    "scripts/ci/validate_tool_versions.py",
    "scripts/docker-build-frontend.sh",
    "scripts/ecs-service-rollout.sh",
    "scripts/postgres-backup.sh",
    "scripts/postgres-restore.sh",
    "scripts/run-db-tests.sh",
    "scripts/run-e2e.sh",
    "scripts/terraform-check.sh",
    "scripts/wait-for-postgres.sh",
]


def repository_files() -> set[str]:
    tracked = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines()
    untracked = subprocess.check_output(
        ["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT, text=True
    ).splitlines()
    return set(tracked + untracked)


class RepositorySurfaceTests(SimpleTestCase):
    def test_manifest_paths_exist(self):
        files = repository_files()
        missing = [path for path in RESOURCE_AUDIT_MANIFEST if path not in files]
        self.assertEqual(missing, [])

    def test_quality_gate_resources_reference_strict_checks(self):
        package_json = (ROOT / "package.json").read_text(encoding="utf-8")
        backend_package = (ROOT / "backend/package.json").read_text(encoding="utf-8")
        frontend_package = (ROOT / "frontend/package.json").read_text(encoding="utf-8")
        pyproject = (ROOT / "backend/pyproject.toml").read_text(encoding="utf-8")
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        frontend_dockerfile = (ROOT / "frontend/Dockerfile").read_text(encoding="utf-8")

        self.assertIn('"test:coverage"', package_json)
        self.assertIn('"quality-gate"', package_json)
        self.assertIn("coverage report --fail-under=100", backend_package)
        self.assertIn("jest --coverage --ci", frontend_package)
        self.assertIn("fail_under = 100", pyproject)
        self.assertIn("Backend - Lint & Test", ci)
        self.assertIn("Frontend Unit Test Coverage", ci)
        self.assertIn("Frontend CI Build Artifact", ci)
        self.assertIn("Security Required Result", ci)
        self.assertIn("Supply Chain Result", ci)
        self.assertIn("CI Result", ci)
        self.assertIn("Playwright E2E", ci)
        self.assertNotIn("cp package-lock.json frontend/", ci)
        self.assertIn("COPY package.json package-lock.docker.json ./", frontend_dockerfile)

        restore = (ROOT / "scripts/postgres-restore.sh").read_text(encoding="utf-8")
        drill = (ROOT / "scripts/backup-restore-drill.sh").read_text(encoding="utf-8")
        rollout = (ROOT / "scripts/ecs-service-rollout.sh").read_text(encoding="utf-8")
        frontend_build = (ROOT / "scripts/docker-build-frontend.sh").read_text(encoding="utf-8")
        self.assertIn("ALLOW_DATABASE_RESTORE", restore)
        self.assertIn("sha256sum --check", restore)
        self.assertIn("database_manifest", drill)
        self.assertIn("migrate", drill)
        self.assertIn("ALLOW_ECS_DEPLOY", rollout)
        self.assertIn("ALLOW_ECS_ROLLBACK", rollout)
        self.assertIn("EXPECTED_CURRENT_TASK_DEFINITION", rollout)
        self.assertIn("deploymentCircuitBreaker={enable=true,rollback=true}", rollout)
        self.assertIn("aws ecs wait services-stable", rollout)
        self.assertIn('"$root_dir/frontend"', frontend_build)
        self.assertIn("docker build", frontend_build)

    def test_deploy_and_runtime_resources_are_clerk_free(self):
        for path in RESOURCE_AUDIT_MANIFEST:
            text = (ROOT / path).read_text(encoding="utf-8", errors="ignore")
            with self.subTest(path=path):
                self.assertNotIn("@clerk", text.lower())
                self.assertNotIn("clerk_", text.lower())
                self.assertNotIn("clerk.com", text.lower())

    def test_admin_theme_templates_reference_scheduler_assets(self):
        login = (ROOT / "backend/src/apps/core/templates/admin/login.html").read_text(
            encoding="utf-8"
        )
        base_site = (ROOT / "backend/src/apps/core/templates/admin/base_site.html").read_text(
            encoding="utf-8"
        )

        self.assertIn("Scheduler Admin", login)
        self.assertIn("scheduler-logo.svg", login)
        self.assertIn("itg_login_styles.html", login)
        self.assertIn("i2g-admin-theme-runtime.js", base_site)
        self.assertIn("google-material-admin-overrides.css", base_site)
