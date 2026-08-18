const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");

const RESOURCE_AUDIT_MANIFEST = [
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-prod.yml.disabled",
  ".gitignore",
  ".pre-commit-config.yaml",
  "README.md",
  "Screenshoot.png",
  "src/api/.dockerignore",
  "src/api/Dockerfile",
  "src/api/docker-entrypoint.sh",
  "src/api/package.json",
  "src/api/pyproject.toml",
  "src/api/requirements/base.txt",
  "src/api/requirements/local.txt",
  "src/api/requirements/production.txt",
  "src/api/apps/authn/templates/admin/authn/member/change_form.html",
  "src/api/apps/authn/templates/admin/authn/member/change_list.html",
  "src/api/apps/authn/templates/admin/authn/member/import_excel.html",
  "src/api/apps/authn/templates/authn/email/admin_invitation.html",
  "src/api/apps/authn/templates/authn/email/email_claim_notification.html",
  "src/api/apps/authn/templates/authn/email/verification_code.html",
  "src/api/apps/authn/templates/authn/invitation/accept.html",
  "src/api/apps/authn/templates/authn/invitation/already_registered.html",
  "src/api/apps/authn/templates/authn/invitation/invalid.html",
  "src/api/apps/authn/templates/authn/invitation/success.html",
  "src/api/apps/core/static/admin/css/file-input.css",
  "src/api/apps/core/static/admin/css/google-material-admin-overrides.css",
  "src/api/apps/core/static/admin/css/google-material-admin.css",
  "src/api/apps/core/static/admin/css/ip-geo-popup.css",
  "src/api/apps/core/static/admin/css/style-sheet-code-editor.css",
  "src/api/apps/core/static/admin/css/tabs.css",
  "src/api/apps/core/static/admin/js/i2g-admin-theme-runtime.js",
  "src/api/apps/core/static/admin/js/material-web-text-field.js",
  "src/api/apps/core/static/images/i2glogo.png",
  "src/api/apps/core/static/images/releviz-mark.png",
  "src/api/apps/core/templates/404.html",
  "src/api/apps/core/templates/admin/actions.html",
  "src/api/apps/core/templates/admin/base_site.html",
  "src/api/apps/core/templates/admin/core/confirm_action.html",
  "src/api/apps/core/templates/admin/core/confirm_change.html",
  "src/api/apps/core/templates/admin/core/export_columns.html",
  "src/api/apps/core/templates/admin/core/test_send_form.html",
  "src/api/apps/core/templates/admin/includes/i2g_admin_theme_toggle.html",
  "src/api/apps/core/templates/admin/includes/itg_submit_line_autosave_script.html",
  "src/api/apps/core/templates/admin/includes/itg_submit_line_autosave_style.html",
  "src/api/apps/core/templates/admin/includes/itg_login_styles.html",
  "src/api/apps/core/templates/admin/index.html",
  "src/api/apps/core/templates/admin/login.html",
  "src/api/apps/core/templates/admin/material_password_widget.html",
  "src/api/apps/core/templates/admin/submit_line.html",
  "src/api/apps/core/templates/index.html",
  "src/api/apps/core/templates/unfold/helpers/app_list_default.html",
  "src/api/apps/core/templates/unfold/helpers/navigation_header.html",
  "src/api/apps/core/templates/unfold/helpers/site_branding.html",
  "src/api/apps/core/templates/unfold/helpers/site_icon.html",
  "src/api/apps/core/templates/unfold/helpers/site_logo.html",
  "src/api/apps/core/templates/unfold/helpers/theme_switch_dropdown.html",
  "src/api/apps/core/templates/unfold/helpers/userlinks.html",
  "src/api/apps/mail/templates/admin/mail/emailproviderconfig/send_test_email.html",
  "src/api/apps/mail/templates/mail/email/branded.html",
  "docker-compose.e2e.yml",
  "src/e2e/accessibility.spec.js",
  "src/e2e/helpers/accessibility.js",
  "src/e2e/playwright.config.js",
  "src/web/.prettierignore",
  "src/web/.dockerignore",
  "src/web/@next/package.json",
  "src/web/Dockerfile",
  "src/web/app/apple-design.css",
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
  "scripts/compile-api-requirements.sh",
  "scripts/db/backup-restore-drill.sh",
  "scripts/db/postgres-backup.sh",
  "scripts/db/postgres-restore.sh",
  "scripts/deploy/ecs-service-rollout.sh",
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
  "scripts/deploy/docker-build-frontend.sh",
  "scripts/run-db-tests.sh",
  "scripts/run-e2e.sh",
  "scripts/setup-api.sh",
  "scripts/ci/terraform-check.sh",
  "scripts/db/wait-for-postgres.sh",
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
    const ci = fs.readFileSync(
      path.join(ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(ci).toContain("Frontend Amplify Static Export");
    expect(ci).toContain("run build:amplify");
    expect(ci).toContain("- frontend-amplify-build");
    expect(ci).toContain('NEXT_E2E_SERVER: "1"');
  });

  test("browser flows run with both durable workers", async () => {
    const config = fs.readFileSync(
      path.join(ROOT, "src/e2e/playwright.config.js"),
      "utf8",
    );
    expect(config).toContain("recompute_event_results --watch");
    expect(config).toContain("dispatch_email_jobs --watch");
    expect(config).toContain("wait: { stdout: /Event results:/ }");
    expect(config).toContain("wait: { stdout: /Email jobs:/ }");
    expect(config).toContain('PYTHONUNBUFFERED: "1"');
    expect(config).toContain('PRINT_EMAILS_TO_TERMINAL: "0"');
    expect(config).toContain('NEXT_E2E_SERVER: "1"');
    const runner = fs.readFileSync(
      path.join(ROOT, "scripts/run-e2e.sh"),
      "utf8",
    );
    expect(runner).toContain('export PYTHON_BIN="$python_bin"');
    expect(runner).toContain("export NEXT_E2E_SERVER=1");
    expect(runner).toContain("export PRINT_EMAILS_TO_TERMINAL=0");
  });

  test("API workspace scripts use the relocatable virtualenv interpreter", async () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, "src/api/package.json"), "utf8"),
    );
    for (const scriptName of [
      "start",
      "test",
      "test:coverage",
      "lint",
      "lint:fix",
      "format",
      "format:check",
    ]) {
      expect(packageJson.scripts[scriptName]).toContain(".venv/bin/python");
    }
    expect(JSON.stringify(packageJson.scripts)).not.toMatch(
      /\.venv\/bin\/(?:coverage|gunicorn)\b/,
    );
  });

  test("frontend static images and admin logo are loadable", async ({
    page,
  }) => {
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
      path.join(ROOT, "src/api/apps/core/static/images/releviz-mark.png"),
    );
    expect(adminMark.subarray(1, 4).toString("ascii")).toBe("PNG");
  });
});
