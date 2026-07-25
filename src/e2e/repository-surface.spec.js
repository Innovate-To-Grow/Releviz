const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");

const RESOURCE_AUDIT_MANIFEST = [
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-prod.yml",
  ".gitignore",
  ".pre-commit-config.yaml",
  ".prettierignore",
  ".prettierrc",
  "README.md",
  "Screenshoot.png",
  "src/backend/Dockerfile",
  "src/backend/docker-entrypoint.sh",
  "src/backend/package.json",
  "src/backend/pyproject.toml",
  "src/backend/requirements/base.txt",
  "src/backend/requirements/local.txt",
  "src/backend/requirements/production.txt",
  "src/backend/apps/core/static/admin/css/file-input.css",
  "src/backend/apps/core/static/admin/css/google-material-admin-overrides.css",
  "src/backend/apps/core/static/admin/css/google-material-admin.css",
  "src/backend/apps/core/static/admin/css/tabs.css",
  "src/backend/apps/core/static/admin/js/i2g-admin-theme-runtime.js",
  "src/backend/apps/core/static/admin/js/material-web-text-field.js",
  "src/backend/apps/core/static/images/releviz-logo.svg",
  "src/backend/apps/core/templates/admin/base_site.html",
  "src/backend/apps/core/templates/admin/includes/i2g_admin_theme_toggle.html",
  "src/backend/apps/core/templates/admin/includes/itg_login_styles.html",
  "src/backend/apps/core/templates/admin/index.html",
  "src/backend/apps/core/templates/admin/login.html",
  "src/backend/apps/core/templates/unfold/helpers/navigation_header.html",
  "src/backend/apps/core/templates/unfold/helpers/site_branding.html",
  "src/backend/apps/core/templates/unfold/helpers/site_logo.html",
  "src/backend/apps/core/templates/unfold/helpers/theme_switch_dropdown.html",
  "src/backend/apps/core/templates/unfold/helpers/userlinks.html",
  "docker-compose.e2e.yml",
  "docs/auth-security.md",
  "docs/email-delivery.md",
  "docs/releviz-goal-progress.md",
  "docs/scheduling-slots.md",
  "src/e2e/accessibility.spec.js",
  "src/e2e/helpers/accessibility.js",
  "src/e2e/playwright.config.js",
  "src/frontend/.prettierignore",
  "src/frontend/.dockerignore",
  "src/frontend/@next/package.json",
  "src/frontend/Dockerfile",
  "src/frontend/app/globals.css",
  "src/frontend/eslint.config.mjs",
  "src/frontend/jest.config.js",
  "src/frontend/jsconfig.json",
  "src/frontend/next.config.js",
  "src/frontend/package-lock.docker.json",
  "src/frontend/package.json",
  "src/frontend/public/favicon.ico",
  "src/frontend/public/homepage.png",
  "src/frontend/public/img/i2glogo.png",
  "src/frontend/public/img/ucmlogo.png",
  "src/frontend/public/logo192.png",
  "src/frontend/public/logo512.png",
  "src/frontend/public/robots.txt",
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
      path.join(ROOT, "src/backend/apps/core/static/images/releviz-logo.svg"),
      "utf8"
    );
    expect(adminLogo).toContain("<svg");
  });
});
