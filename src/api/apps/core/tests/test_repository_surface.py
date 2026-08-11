import subprocess
from pathlib import Path

from django.test import SimpleTestCase

ROOT = Path(__file__).resolve().parents[5]

RESOURCE_AUDIT_MANIFEST = [
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-prod.yml",
    ".gitignore",
    ".pre-commit-config.yaml",
    ".prettierignore",
    ".prettierrc",
    "README.md",
    "Screenshoot.png",
    "src/api/Dockerfile",
    "src/api/docker-entrypoint.sh",
    "src/api/package.json",
    "src/api/pyproject.toml",
    "src/api/requirements/base.txt",
    "src/api/requirements/local.txt",
    "src/api/requirements/production.txt",
    "src/api/apps/core/static/admin/css/file-input.css",
    "src/api/apps/core/static/admin/css/google-material-admin-overrides.css",
    "src/api/apps/core/static/admin/css/google-material-admin.css",
    "src/api/apps/core/static/admin/css/tabs.css",
    "src/api/apps/core/static/admin/js/i2g-admin-theme-runtime.js",
    "src/api/apps/core/static/admin/js/material-web-text-field.js",
    "src/api/apps/core/static/images/releviz-mark.png",
    "src/api/apps/core/templates/admin/base_site.html",
    "src/api/apps/core/templates/admin/includes/i2g_admin_theme_toggle.html",
    "src/api/apps/core/templates/admin/includes/itg_login_styles.html",
    "src/api/apps/core/templates/admin/index.html",
    "src/api/apps/core/templates/admin/login.html",
    "src/api/apps/core/templates/unfold/helpers/navigation_header.html",
    "src/api/apps/core/templates/unfold/helpers/site_branding.html",
    "src/api/apps/core/templates/unfold/helpers/site_logo.html",
    "src/api/apps/core/templates/unfold/helpers/theme_switch_dropdown.html",
    "src/api/apps/core/templates/unfold/helpers/userlinks.html",
    "src/api/apps/messaging/templates/messaging/email/branded.html",
    "docker-compose.e2e.yml",
    "docs/auth-security.md",
    "docs/backup-restore.md",
    "docs/deployment-rollback.md",
    "docs/email-delivery.md",
    "docs/observability.md",
    "docs/performance-benchmarks.md",
    "docs/product-analytics.md",
    "docs/real-user-validation-plan.md",
    "docs/releviz-goal-progress.md",
    "docs/roster-imports.md",
    "docs/scheduling-slots.md",
    "docs/temporary-accounts.md",
    "docs/worker-runbook.md",
    "src/e2e/accessibility.spec.js",
    "src/e2e/helpers/accessibility.js",
    "src/e2e/playwright.config.js",
    "src/web/.prettierignore",
    "src/web/.dockerignore",
    "src/web/@next/package.json",
    "src/web/Dockerfile",
    "src/web/app/apple-icon.png",
    "src/web/app/globals.css",
    "src/web/app/icon.png",
    "src/web/app/opengraph-image.alt.txt",
    "src/web/app/opengraph-image.png",
    "src/web/app/twitter-image.alt.txt",
    "src/web/app/twitter-image.png",
    "src/web/app/temp-access/temp-access.module.css",
    "src/web/eslint.config.mjs",
    "src/web/amplify-routes.json",
    "src/web/jest.config.js",
    "src/web/jsconfig.json",
    "src/web/next.config.js",
    "src/web/package-lock.docker.json",
    "src/web/package.json",
    "src/web/vendor/brace-expansion-compat/package.json",
    "src/web/public/brand/releviz-logo.png",
    "src/web/public/brand/releviz-mark.png",
    "src/web/public/favicon.ico",
    "src/web/public/homepage.png",
    "src/web/public/img/ucmlogo.png",
    "src/web/public/logo192.png",
    "src/web/public/logo512.png",
    "src/web/public/manifest.json",
    "src/web/public/robots.txt",
    "infra/bootstrap/README.md",
    "infra/bootstrap/main.tf",
    "infra/bootstrap/provision-amplify.sh",
    "infra/bootstrap/tests/plan.tftest.hcl",
    "infra/prod/main.tf",
    "infra/prod/outputs.tf",
    "infra/prod/prod.tfvars.example",
    "infra/prod/tests/plan.tftest.hcl",
    "infra/prod/variables.tf",
    "infra/prod/versions.tf",
    "package-lock.json",
    "package.json",
    "scripts/quality-gate.sh",
    "scripts/db/backup-restore-drill.sh",
    "scripts/ci/audit-test-surface.py",
    "scripts/ci/check_bundle_size.py",
    "scripts/ci/check_npm_licenses.py",
    "scripts/ci/plan_django_tests.py",
    "scripts/ci/plan_e2e_tests.py",
    "scripts/ci/summarize_workflow_jobs.py",
    "scripts/ci/validate_amplify_static_export.py",
    "scripts/ci/validate_deployment_contract.py",
    "scripts/ci/validate_dependabot_labels.py",
    "scripts/ci/validate_tool_versions.py",
    "scripts/deploy/amplify-apex-target.sh",
    "scripts/deploy/amplify-static-deploy.sh",
    "scripts/deploy/docker-build-frontend.sh",
    "scripts/deploy/ecs-service-rollout.sh",
    "scripts/db/postgres-backup.sh",
    "scripts/db/postgres-restore.sh",
    "scripts/run-db-tests.sh",
    "scripts/run-e2e.sh",
    "scripts/ci/terraform-check.sh",
    "scripts/db/wait-for-postgres.sh",
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
        backend_package = (ROOT / "src/api/package.json").read_text(encoding="utf-8")
        frontend_package = (ROOT / "src/web/package.json").read_text(encoding="utf-8")
        pyproject = (ROOT / "src/api/pyproject.toml").read_text(encoding="utf-8")
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        frontend_dockerfile = (ROOT / "src/web/Dockerfile").read_text(encoding="utf-8")

        self.assertIn('"test:coverage"', package_json)
        self.assertIn('"quality-gate"', package_json)
        self.assertIn("coverage report --fail-under=100", backend_package)
        self.assertIn("jest --coverage --ci", frontend_package)
        self.assertIn("fail_under = 100", pyproject)
        self.assertIn("Backend - Lint & Test", ci)
        self.assertIn("Frontend Unit Test Coverage", ci)
        self.assertIn("Frontend CI Build Artifact", ci)
        self.assertIn("Frontend Amplify Static Export", ci)
        self.assertIn("run build:amplify", ci)
        self.assertIn("- frontend-amplify-build", ci)
        self.assertIn("Security Required Result", ci)
        self.assertIn("Supply Chain Result", ci)
        self.assertIn("CI Result", ci)
        self.assertIn("Playwright E2E", ci)
        self.assertNotIn("cp package-lock.json src/web/", ci)
        self.assertIn("COPY package.json package-lock.docker.json ./", frontend_dockerfile)
        self.assertIn(
            "COPY vendor/brace-expansion-compat ./vendor/brace-expansion-compat",
            frontend_dockerfile,
        )

        restore = (ROOT / "scripts/db/postgres-restore.sh").read_text(encoding="utf-8")
        drill = (ROOT / "scripts/db/backup-restore-drill.sh").read_text(encoding="utf-8")
        rollout = (ROOT / "scripts/deploy/ecs-service-rollout.sh").read_text(encoding="utf-8")
        frontend_build = (ROOT / "scripts/deploy/docker-build-frontend.sh").read_text(encoding="utf-8")
        self.assertIn("ALLOW_DATABASE_RESTORE", restore)
        self.assertIn("sha256sum --check", restore)
        self.assertIn("database_manifest", drill)
        self.assertIn("migrate", drill)
        self.assertIn("ALLOW_ECS_DEPLOY", rollout)
        self.assertIn("ALLOW_ECS_ROLLBACK", rollout)
        self.assertIn("EXPECTED_CURRENT_TASK_DEFINITION", rollout)
        self.assertIn("deploymentCircuitBreaker={enable=true,rollback=true}", rollout)
        self.assertIn("aws ecs wait services-stable", rollout)
        self.assertIn('"$root_dir/src/web"', frontend_build)
        self.assertIn("docker build", frontend_build)

    def test_deploy_and_runtime_resources_are_clerk_free(self):
        for path in RESOURCE_AUDIT_MANIFEST:
            text = (ROOT / path).read_text(encoding="utf-8", errors="ignore")
            with self.subTest(path=path):
                self.assertNotIn("@clerk", text.lower())
                self.assertNotIn("clerk_", text.lower())
                self.assertNotIn("clerk.com", text.lower())

    def test_admin_theme_templates_reference_releviz_assets(self):
        login = (ROOT / "src/api/apps/core/templates/admin/login.html").read_text(
            encoding="utf-8"
        )
        base_site = (ROOT / "src/api/apps/core/templates/admin/base_site.html").read_text(
            encoding="utf-8"
        )

        self.assertIn("Releviz Admin", login)
        self.assertIn("releviz-mark.png", login)
        self.assertIn("itg_login_styles.html", login)
        self.assertIn("i2g-admin-theme-runtime.js", base_site)
        self.assertIn("google-material-admin-overrides.css", base_site)
