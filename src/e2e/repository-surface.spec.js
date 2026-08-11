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
  "src/api/apps/core/static/images/releviz-logo.svg",
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
  "docker-compose.e2e.yml",
  "docs/auth-security.md",
  "docs/email-delivery.md",
  "docs/releviz-goal-progress.md",
  "docs/scheduling-slots.md",
  "docs/temporary-accounts.md",
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
  "src/web/public/img/i2glogo.png",
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

  test("CI requires an Amplify static export", async () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("Frontend Amplify Static Export");
    expect(ci).toContain("run build:amplify");
    expect(ci).toContain("- frontend-amplify-build");
  });

  test("frontend static images and admin logo are loadable", async ({ page }) => {
    for (const asset of [
      "/favicon.ico",
      "/homepage.png",
      "/img/ucmlogo.png",
      "/logo192.png",
      "/logo512.png",
      "/manifest.json",
      "/brand/releviz-logo.png",
      "/brand/releviz-mark.png",
      "/apple-icon.png",
      "/icon.png",
      "/opengraph-image.png",
      "/twitter-image.png",
    ]) {
      const response = await page.goto(asset);
      expect(response?.ok(), asset).toBeTruthy();
    }

    const adminMark = fs.readFileSync(
      path.join(ROOT, "src/api/apps/core/static/images/releviz-mark.png")
    );
    expect(adminMark.subarray(1, 4).toString("ascii")).toBe("PNG");
  });
});
