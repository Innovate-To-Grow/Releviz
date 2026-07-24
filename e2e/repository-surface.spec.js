const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");

const RESOURCE_AUDIT_MANIFEST = [
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-prod.yml.disabled",
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
  "docs/email-delivery.md",
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
  "scripts/ci/check_bundle_size.py",
  "scripts/ci/check_npm_licenses.py",
  "scripts/ci/plan_django_tests.py",
  "scripts/ci/plan_e2e_tests.py",
  "scripts/ci/summarize_workflow_jobs.py",
  "scripts/ci/validate_deployment_contract.py",
  "scripts/ci/validate_dependabot_labels.py",
  "scripts/ci/validate_tool_versions.py",
  "scripts/docker-build-frontend.sh",
  "scripts/run-db-tests.sh",
  "scripts/run-e2e.sh",
  "scripts/terraform-check.sh",
  "scripts/wait-for-postgres.sh",
];

test.describe("repository resource audit", () => {
  test("all audited resources exist and stay Clerk-free", async () => {
    for (const entry of RESOURCE_AUDIT_MANIFEST) {
      const fullPath = path.join(ROOT, entry);
      expect(fs.existsSync(fullPath), entry).toBeTruthy();
      const bytes = fs.readFileSync(fullPath);
      expect(bytes.length, entry).toBeGreaterThan(0);
      const text = bytes.toString("utf8").toLowerCase();
      expect(text, entry).not.toContain("@clerk");
      expect(text, entry).not.toContain("clerk_");
      expect(text, entry).not.toContain("clerk.com");
    }
  });

  test("frontend static images and admin logo are loadable", async ({ page }) => {
    for (const asset of [
      "/favicon.ico",
      "/homepage.png",
      "/img/i2glogo.png",
      "/img/ucmlogo.png",
      "/logo192.png",
      "/logo512.png",
    ]) {
      const response = await page.goto(asset);
      expect(response?.ok(), asset).toBeTruthy();
    }

    const adminLogo = fs.readFileSync(
      path.join(ROOT, "backend/src/apps/core/static/images/scheduler-logo.svg"),
      "utf8"
    );
    expect(adminLogo).toContain("<svg");
  });
});
