import subprocess
from pathlib import Path

from django.test import SimpleTestCase

ROOT = Path(__file__).resolve().parents[5]

RESOURCE_AUDIT_MANIFEST = [
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-staging.yml",
    ".gitignore",
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
    "e2e/playwright.config.js",
    "frontend/.prettierignore",
    "frontend/@next/package.json",
    "frontend/Dockerfile",
    "frontend/app/globals.css",
    "frontend/eslint.config.mjs",
    "frontend/jest.config.js",
    "frontend/jsconfig.json",
    "frontend/next.config.js",
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
    "infra/prod/variables.tf",
    "infra/prod/versions.tf",
    "infra/staging/main.tf",
    "infra/staging/outputs.tf",
    "infra/staging/variables.tf",
    "infra/staging/versions.tf",
    "package-lock.json",
    "package.json",
    "scripts/quality-gate.sh",
    "scripts/run-db-tests.sh",
    "scripts/run-e2e.sh",
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

        self.assertIn('"test:coverage"', package_json)
        self.assertIn('"quality-gate"', package_json)
        self.assertIn("coverage report --fail-under=100", backend_package)
        self.assertIn("jest --coverage --ci", frontend_package)
        self.assertIn("fail_under = 100", pyproject)
        self.assertIn("Backend - Lint & Test", ci)
        self.assertIn("Frontend - Lint, Test & Build", ci)
        self.assertIn("Playwright E2E", ci)

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
