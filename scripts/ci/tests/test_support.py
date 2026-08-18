import json
import os
import subprocess
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from scripts.ci.check_bundle_size import check_budgets, collect_assets
from scripts.ci.check_npm_licenses import package_inventory
from scripts.ci.summarize_workflow_jobs import render
from scripts.ci.validate_amplify_static_export import amplify_static_export_errors
from scripts.ci.validate_deployment_contract import (
    amplify_deploy_script_errors,
    production_alb_security_group_errors,
    production_amplify_custom_headers_errors,
    production_amplify_custom_headers_policy_errors,
    production_cd_errors,
    production_cd_path,
    production_default_admin_task_errors,
    production_ecs_task_definition_errors,
    production_proxy_configuration_errors,
    production_worker_entrypoint_errors,
    production_worker_errors,
    required_runtime_environment,
    terraform_environment_names,
)


class BundleBudgetTests(TestCase):
    def test_collect_and_check_assets(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "app.js").write_bytes(b"x" * 10)
            (root / "style.css").write_bytes(b"x" * 5)
            (root / "ignored.map").write_bytes(b"x" * 100)
            assets = collect_assets(root)
            self.assertEqual(sum(size for _, size in assets), 15)
            self.assertEqual(check_budgets(assets, max_total_bytes=20, max_file_bytes=10), [])
            self.assertEqual(len(check_budgets(assets, max_total_bytes=14, max_file_bytes=9)), 2)


class LicenseReportTests(TestCase):
    def test_package_inventory_ignores_workspace_links(self):
        lock = {
            "packages": {
                "": {"name": "root"},
                "src/web": {"link": True},
                "node_modules/demo": {"version": "1.0.0", "license": "MIT"},
            }
        }
        self.assertEqual(
            package_inventory(lock),
            [
                {
                    "name": "demo",
                    "version": "1.0.0",
                    "license": "MIT",
                    "location": "node_modules/demo",
                }
            ],
        )


class TimingSummaryTests(TestCase):
    def test_render_orders_jobs_by_duration(self):
        payload = json.loads(
            '{"jobs":['
            '{"name":"short","conclusion":"success","started_at":"2026-01-01T00:00:00Z",'
            '"completed_at":"2026-01-01T00:00:01Z"},'
            '{"name":"long","conclusion":"failure","started_at":"2026-01-01T00:00:00Z",'
            '"completed_at":"2026-01-01T00:00:03Z"}'
            "]}"
        )
        summary = render(payload)
        self.assertLess(summary.index("long"), summary.index("short"))
        self.assertIn("Total runner time across 2 jobs: 4.0s.", summary)


class AmplifyStaticExportTests(TestCase):
    def test_export_matches_route_manifest_and_contains_javascript(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "out"
            assets = output / "_next/static/chunks"
            assets.mkdir(parents=True)
            manifest = root / "amplify-routes.json"
            manifest.write_text(
                json.dumps(
                    {
                        "static_routes": ["dashboard", "login", "signup"],
                        "legacy_redirects": {
                            "sign-in": "login",
                            "sign-up": "signup",
                        },
                    }
                ),
                encoding="utf-8",
            )
            for page in (
                "index",
                "404",
                "_not-found",
                "dashboard",
                "login",
                "signup",
                "sign-in",
                "sign-up",
            ):
                (output / f"{page}.html").write_text(page, encoding="utf-8")
            (assets / "app.js").write_text("export {};", encoding="utf-8")

            self.assertEqual(amplify_static_export_errors(output, manifest), [])

    def test_export_rejects_missing_unlisted_routes_and_missing_javascript(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "out"
            output.mkdir()
            manifest = root / "amplify-routes.json"
            manifest.write_text(
                json.dumps(
                    {
                        "static_routes": ["dashboard", "login"],
                        "legacy_redirects": {"sign-in": "login"},
                    }
                ),
                encoding="utf-8",
            )
            (output / "index.html").write_text("home", encoding="utf-8")
            (output / "dashboard.html").write_text("dashboard", encoding="utf-8")
            (output / "unlisted.html").write_text("unknown", encoding="utf-8")

            errors = amplify_static_export_errors(output, manifest)

            self.assertIn(
                "Amplify static export is missing route HTML: ['login', 'sign-in']",
                errors,
            )
            self.assertIn(
                "Amplify static export has unlisted root route HTML: ['unlisted']",
                errors,
            )
            self.assertIn("Amplify static export has no _next/static JavaScript asset", errors)


class AmplifyApexTargetTests(TestCase):
    script = Path(__file__).resolve().parents[3] / "scripts" / "deploy" / "amplify-apex-target.sh"

    def extract(self, subdomains, branch="main"):
        return subprocess.run(
            ["bash", str(self.script), branch],
            input=json.dumps({"domainAssociation": {"subDomains": subdomains}}),
            text=True,
            capture_output=True,
            check=False,
        )

    def test_accepts_aws_omitted_apex_prefix_and_normalizes_target(self):
        result = self.extract(
            [
                {
                    "subDomainSetting": {"branchName": "main"},
                    "dnsRecord": " CNAME D161PBWA2VPG59.CLOUDFRONT.NET.",
                }
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "d161pbwa2vpg59.cloudfront.net")

    def test_accepts_explicit_empty_prefix_and_ignores_other_subdomains(self):
        result = self.extract(
            [
                {
                    "subDomainSetting": {
                        "prefix": "www",
                        "branchName": "main",
                    },
                    "dnsRecord": "www CNAME ignored.example.net",
                },
                {
                    "subDomainSetting": {
                        "prefix": "",
                        "branchName": "main",
                    },
                    "dnsRecord": " CNAME expected.example.net",
                },
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "expected.example.net")

    def test_rejects_missing_or_ambiguous_apex_mapping(self):
        missing = self.extract(
            [
                {
                    "subDomainSetting": {
                        "prefix": "www",
                        "branchName": "main",
                    },
                    "dnsRecord": "www CNAME ignored.example.net",
                }
            ]
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("missing unique apex DNS record", missing.stderr)

        ambiguous = self.extract(
            [
                {
                    "subDomainSetting": {"branchName": "main"},
                    "dnsRecord": " CNAME one.example.net",
                },
                {
                    "subDomainSetting": {
                        "prefix": "",
                        "branchName": "main",
                    },
                    "dnsRecord": " CNAME two.example.net",
                },
            ]
        )
        self.assertNotEqual(ambiguous.returncode, 0)
        self.assertIn("missing unique apex DNS record", ambiguous.stderr)

    def test_rejects_non_string_apex_prefixes(self):
        for malformed_prefix in (None, False):
            with self.subTest(prefix=malformed_prefix):
                result = self.extract(
                    [
                        {
                            "subDomainSetting": {
                                "prefix": malformed_prefix,
                                "branchName": "main",
                            },
                            "dnsRecord": " CNAME malformed.example.net",
                        }
                    ]
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("missing unique apex DNS record", result.stderr)


class DeploymentContractTests(TestCase):
    def test_production_amplify_headers_ignore_only_formatting_drift(self):
        source = """
locals {
  amplify_custom_headers = []
}

resource "aws_amplify_app" "frontend" {
  custom_headers = file("${path.module}/amplify-custom-headers.json")

  lifecycle {
    ignore_changes = [custom_headers]

    postcondition {
      condition = try(
        jsonencode(try(
          yamldecode(self.custom_headers).customHeaders,
          yamldecode(self.custom_headers),
        )) == jsonencode(local.amplify_custom_headers),
        false,
      )
      error_message = "semantic drift"
    }
  }
}

resource "aws_amplify_branch" "candidate" {
}
"""
        self.assertEqual(production_amplify_custom_headers_errors(source), [])

        cases = (
            (
                "ignore_changes = [custom_headers]",
                "ignore_changes = []",
                (
                    "production Terraform does not suppress provider-only Amplify "
                    "custom-header formatting drift"
                ),
            ),
            (
                "yamldecode(self.custom_headers).customHeaders",
                "yamldecode(self.custom_headers).unexpected",
                (
                    "production Terraform does not reject semantic JSON or YAML drift in live "
                    "Amplify custom headers"
                ),
            ),
            (
                "yamldecode(self.custom_headers),",
                "[],",
                (
                    "production Terraform does not reject semantic JSON or YAML drift in live "
                    "Amplify custom headers"
                ),
            ),
            (
                "yamldecode(self.custom_headers),",
                "yamldecode(self.custom_headers).customHeaders,",
                (
                    "production Terraform does not reject semantic JSON or YAML drift in live "
                    "Amplify custom headers"
                ),
            ),
            (
                'custom_headers = file("${path.module}/amplify-custom-headers.json")',
                "custom_headers = jsonencode(local.amplify_custom_headers)",
                (
                    "production Terraform does not render Amplify custom headers from the "
                    "reviewed policy file"
                ),
            ),
            (
                "false,\n      )",
                "true,\n      )",
                (
                    "production Terraform does not reject semantic JSON or YAML drift in live "
                    "Amplify custom headers"
                ),
            ),
        )
        for expected, replacement, error in cases:
            with self.subTest(expected=expected):
                self.assertIn(
                    error,
                    production_amplify_custom_headers_errors(source.replace(expected, replacement)),
                )

        misplaced_guard = (
            source.replace(
                "ignore_changes = [custom_headers]",
                "ignore_changes = []",
                1,
            ).replace(
                "yamldecode(self.custom_headers).customHeaders",
                "yamldecode(self.custom_headers).unexpected",
                1,
            )
            + """
resource "terraform_data" "decoy" {
  lifecycle {
    ignore_changes = [custom_headers]
    postcondition {
      condition = try(
        jsonencode(try(
          yamldecode(self.custom_headers).customHeaders,
          yamldecode(self.custom_headers),
        )) == jsonencode(local.amplify_custom_headers),
        false,
      )
      error_message = "semantic drift"
    }
  }
}
"""
        )
        misplaced_errors = production_amplify_custom_headers_errors(misplaced_guard)
        self.assertIn(
            (
                "production Terraform does not suppress provider-only Amplify "
                "custom-header formatting drift"
            ),
            misplaced_errors,
        )
        self.assertIn(
            (
                "production Terraform does not reject semantic JSON or YAML drift in live "
                "Amplify custom headers"
            ),
            misplaced_errors,
        )

    def test_production_amplify_headers_policy_has_top_level_custom_headers(self):
        valid_policy = {
            "customHeaders": [
                {
                    "pattern": "**",
                    "headers": [
                        {
                            "key": "Content-Security-Policy",
                            "value": (
                                "default-src 'self'; base-uri 'self'; object-src 'none'; "
                                "frame-ancestors 'none'; script-src 'self' 'unsafe-inline' "
                                "https://challenges.cloudflare.com; connect-src 'self' "
                                "https://api.releviz.com https://challenges.cloudflare.com; "
                                "frame-src 'self' https://challenges.cloudflare.com; "
                                "form-action 'self'; upgrade-insecure-requests;"
                            ),
                        }
                    ],
                }
            ]
        }
        self.assertEqual(
            production_amplify_custom_headers_policy_errors(json.dumps(valid_policy)),
            [],
        )
        self.assertEqual(
            production_amplify_custom_headers_policy_errors("not-json"),
            ["production Amplify custom-header policy is not valid JSON"],
        )
        self.assertEqual(
            production_amplify_custom_headers_policy_errors("[]"),
            ["production Amplify custom-header policy must be a top-level JSON object"],
        )
        self.assertEqual(
            production_amplify_custom_headers_policy_errors(json.dumps({"headers": []})),
            ["production Amplify custom-header policy omits the top-level customHeaders list"],
        )
        self.assertEqual(
            production_amplify_custom_headers_policy_errors(json.dumps({"customHeaders": []})),
            ["production Amplify custom-header policy must contain one global policy"],
        )
        unsafe_policy = json.loads(json.dumps(valid_policy))
        unsafe_policy["customHeaders"][0]["headers"][0]["value"] += " script-src 'unsafe-eval'"
        self.assertIn(
            "production Amplify CSP retains forbidden source 'unsafe-eval'",
            production_amplify_custom_headers_policy_errors(json.dumps(unsafe_policy)),
        )

    def test_production_alb_security_group_is_in_place_only(self):
        source = """
resource "aws_security_group" "alb" {
  name        = "releviz-prod-alb-sg"
  description = "Allow public HTTP and HTTPS ingress to the load balancer"

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_security_group" "backend" {
}
"""
        self.assertEqual(production_alb_security_group_errors(source), [])
        self.assertIn(
            "production Terraform changes the immutable live ALB security-group description",
            production_alb_security_group_errors(
                source.replace(
                    "Allow public HTTP and HTTPS ingress to the load balancer",
                    "Allow controlled HTTPS ingress to the load balancer",
                )
            ),
        )
        self.assertIn(
            "production Terraform omits ALB security-group destroy protection",
            production_alb_security_group_errors(
                source.replace("prevent_destroy = true", "prevent_destroy = false")
            ),
        )
        self.assertIn(
            "production Terraform omits public IPv4 HTTPS ingress on the ALB",
            production_alb_security_group_errors(
                source.replace(
                    'cidr_blocks = ["0.0.0.0/0"]',
                    'cidr_blocks = ["10.0.0.0/8"]',
                )
            ),
        )

    def test_production_proxy_configuration_is_one_public_alb_hop(self):
        source = """
environment = [
  { name = "AUTH_TRUSTED_PROXY_COUNT", value = "1" },
]
"""
        self.assertEqual(production_proxy_configuration_errors(source), [])
        self.assertIn(
            "production Terraform must set AUTH_TRUSTED_PROXY_COUNT exactly once to 1",
            production_proxy_configuration_errors(source.replace('value = "1"', 'value = "2"')),
        )

        retired_inputs = {
            'data "aws_ec2_managed_prefix_list" "cloudfront" {\n'
            '  name = "com.amazonaws.global.cloudfront.origin-facing"\n'
            "}": (
                "production Terraform retains the retired AWS-managed CloudFront origin prefix list"
            ),
            "var.restrict_origin_to_cloudfront": (
                "production Terraform retains the retired CloudFront-only origin gate"
            ),
            "var.trust_cloudfront_proxy_chain": (
                "production Terraform retains the retired trusted CloudFront proxy-chain gate"
            ),
            'name = "AUTH_TRUSTED_PROXY_CIDRS"': (
                "production Terraform retains the retired CloudFront CIDR runtime allowlist"
            ),
            'name = "AUTH_TRUSTED_PROXY_CIDR_HOPS"': (
                "production Terraform retains the retired CIDR-verified proxy-hop configuration"
            ),
            "cloudfront_origin_facing.entries": (
                "production Terraform retains the retired CloudFront prefix-list CIDR expansion"
            ),
        }
        for retired_source, expected_error in retired_inputs.items():
            with self.subTest(expected_error=expected_error):
                self.assertIn(
                    expected_error,
                    production_proxy_configuration_errors(f"{source}\n{retired_source}\n"),
                )

    def test_production_ecs_task_definitions_pin_provider_defaults(self):
        task_definition = """
enable_fault_injection = false
mountPoints = []
systemControls = []
volumesFrom = []
"""
        source = task_definition * 5
        self.assertEqual(production_ecs_task_definition_errors(source), [])

        for field, expected_error in {
            "enable_fault_injection = false": (
                "production Terraform must set explicitly disabled ECS fault "
                "injection on all five ECS task definitions"
            ),
            "mountPoints = []": (
                "production Terraform must set canonical empty ECS mount points "
                "on all five ECS task definitions"
            ),
            "systemControls = []": (
                "production Terraform must set canonical empty ECS system controls "
                "on all five ECS task definitions"
            ),
            "volumesFrom = []": (
                "production Terraform must set canonical empty ECS volume sources "
                "on all five ECS task definitions"
            ),
        }.items():
            with self.subTest(field=field):
                self.assertIn(
                    expected_error,
                    production_ecs_task_definition_errors(source.replace(field, "", 1)),
                )

    def test_production_workers_monitor_terminal_email_outcomes(self):
        source = (Path(__file__).resolve().parents[3] / "infra/prod/main.tf").read_text(
            encoding="utf-8"
        )
        self.assertEqual(production_worker_errors(source), [])

        self.assertIn(
            (
                "production Terraform permanent_email_failures metric filter omits its "
                "email-worker log source"
            ),
            production_worker_errors(
                source.replace(
                    "log_group_name = aws_cloudwatch_log_group.email_worker.name",
                    "log_group_name = aws_cloudwatch_log_group.backend.name",
                    1,
                )
            ),
        )
        self.assertIn(
            (
                "production Terraform uncertain_email_outcomes metric filter omits its "
                "structured event filter"
            ),
            production_worker_errors(
                source.replace("email_delivery_outcome_uncertain", "other_event", 1)
            ),
        )
        self.assertIn(
            "production worker health check does not reject pending migrations",
            production_worker_errors(
                source.replace(
                    "python manage.py migrate --check --noinput",
                    "python manage.py check",
                    1,
                )
            ),
        )

    def test_worker_entrypoint_runs_only_locked_migrations_before_command(self):
        source = (Path(__file__).resolve().parents[3] / "src/api/docker-entrypoint.sh").read_text(
            encoding="utf-8"
        )
        self.assertEqual(production_worker_entrypoint_errors(source), [])
        self.assertIn(
            "backend entrypoint worker startup omits locked migrations",
            production_worker_entrypoint_errors(
                source.replace(
                    "python manage.py migrate_locked --noinput",
                    "python manage.py check",
                    1,
                )
            ),
        )
        self.assertIn(
            "backend entrypoint worker startup runs web-only mutation tasks",
            production_worker_entrypoint_errors(
                source.replace(
                    "python manage.py migrate_locked --noinput",
                    (
                        "python manage.py migrate_locked --noinput\n"
                        "  python manage.py collectstatic --noinput"
                    ),
                    1,
                )
            ),
        )

    def test_default_admin_task_is_dedicated_and_create_only(self):
        source = """
locals {
  application_secret_arns = compact([
    var.default_admin_password_secret_arn,
  ])
  default_admin_container_environment = [
    { name = "DJANGO_SKIP_STARTUP_TASKS", value = "1" },
    { name = "DJANGO_CREATE_DEFAULT_ADMIN", value = "0" },
    { name = "DJANGO_SUPERUSER_EMAIL", value = var.default_admin_email },
  ]
  default_admin_container_secrets = [
    {
      name      = "DJANGO_SUPERUSER_PASSWORD"
      valueFrom = "${var.default_admin_password_secret_arn}:password::"
    },
  ]
}
resource "aws_ecs_task_definition" "backend" {
  container_definitions = jsonencode([{
    environment = [
      { name = "DJANGO_CREATE_DEFAULT_ADMIN", value = "0" },
    ]
  }])
}
resource "aws_ecs_task_definition" "default_admin" {
  family = "${local.prefix}-default-admin-task"
  image = local.backend_image_uri
  command = ["python", "manage.py", "ensure_default_admin", "--yes", "--create-only"]
  environment = local.default_admin_container_environment
  secrets = local.default_admin_container_secrets
}
resource "aws_ecs_task_definition" "frontend" {}
"""
        self.assertEqual(production_default_admin_task_errors(source), [])

        mutations = {
            '"--create-only"': "production Terraform omits the create-only default-admin command",
            '"DJANGO_SKIP_STARTUP_TASKS"': (
                "production Terraform omits startup-task suppression in the default-admin task"
            ),
            '"DJANGO_SUPERUSER_PASSWORD"': (
                "production Terraform omits Secrets Manager password injection in the "
                "dedicated task"
            ),
            "environment = local.default_admin_container_environment": (
                "production Terraform omits the dedicated default-admin environment reference"
            ),
            "secrets = local.default_admin_container_secrets": (
                "production Terraform omits the dedicated default-admin secrets reference"
            ),
            "image = local.backend_image_uri": (
                "production Terraform omits the immutable backend image in the dedicated "
                "default-admin task"
            ),
            "var.default_admin_password_secret_arn,\n  ])": (
                "the ECS execution role secret allowlist omits the default-admin password ARN"
            ),
        }
        for needle, expected_error in mutations.items():
            with self.subTest(needle=needle):
                self.assertIn(
                    expected_error,
                    production_default_admin_task_errors(source.replace(needle, "missing", 1)),
                )

    def test_required_runtime_environment_reads_required_calls_and_security_lists(self):
        source = """
SECRET_KEY = required_env("DJANGO_SECRET_KEY")
DATABASE = required_env("DB_PASSWORD")
OPTIONAL = os.environ.get("OPTIONAL", "")
"""
        self.assertEqual(
            required_runtime_environment(source),
            {
                "CORS_ALLOWED_ORIGINS",
                "CSRF_TRUSTED_ORIGINS",
                "DB_PASSWORD",
                "DJANGO_ALLOWED_HOSTS",
                "DJANGO_SECRET_KEY",
            },
        )

    def test_terraform_environment_names_reads_environment_and_secret_entries(self):
        source = """
environment = [{ name = "DJANGO_SECRET_KEY", value = "test" }]
secrets = [
  { name = "DB_PASSWORD", valueFrom = "arn:test" },
  { name = "METRICS_BEARER_TOKEN", valueFrom = "arn:test" },
]
"""
        self.assertEqual(
            terraform_environment_names(source),
            {"DB_PASSWORD", "DJANGO_SECRET_KEY", "METRICS_BEARER_TOKEN"},
        )

    def test_production_cd_requires_protected_amplify_release(self):
        self.maxDiff = None
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github/workflows"
            workflows.mkdir(parents=True)
            workflow = workflows / "deploy-prod.yml"
            workflow.write_text(
                """
on:
  workflow_dispatch:
permissions:
  actions: read
  id-token: write
timeout-minutes: 160
PRODUCTION_JOB_TIMEOUT_SECONDS: "9600"
AMPLIFY_TIMEOUT_SECONDS: "1200"
TF_VAR_default_admin_email: ${{ vars.PROD_DEFAULT_ADMIN_EMAIL || 'admin@releviz.com' }}
TF_VAR_default_admin_password_secret_arn: ${{ vars.PROD_DEFAULT_ADMIN_PASSWORD_SECRET_ARN }}
steps:
  - name: Record production job time budget
    id: job_budget
    run: echo "started_at=$(date +%s)" >>"$GITHUB_OUTPUT"
  - uses: hashicorp/setup-terraform@v4
    with:
      terraform_wrapper: false
  - run: |
      if [ "$CONFIRMATION" != "DEPLOY" ]; then exit 1; fi
      git rev-parse HEAD
      echo "CI Result"
      echo "TF_VAR_backend_image_tag: $DEPLOY_SHA"
  - name: Validate production configuration
    run: |
      if [ "$DEFAULT_ADMIN_EMAIL" != "admin@releviz.com" ]; then exit 1; fi
      if ! jq -en \
        --arg django "$DJANGO_SECRET_KEY_ARN" \
        --arg field "$FIELD_ENCRYPTION_KEY_ARN" \
        --arg metrics "$METRICS_BEARER_TOKEN_ARN" \
        --arg admin "$DEFAULT_ADMIN_PASSWORD_SECRET_ARN" '
          [$django, $field, $metrics, $admin] as $secrets
          | ($secrets | length) == ($secrets | unique | length)
        '; then exit 1; fi
  - name: Verify deployment identity and managed dependencies
    run: |
      default_admin_secret_name="$(
        aws secretsmanager describe-secret \
          --secret-id "$DEFAULT_ADMIN_PASSWORD_SECRET_ARN" \
          --query Name \
          --output text
      )"
      if [ "$default_admin_secret_name" != "releviz/prod/default-admin-password" ]; then
        exit 1
      fi
  - run: |
      aws ecs describe-task-definition
      echo "TF_VAR_frontend_image_tag: ${{ github.sha }}"
      echo "Build and push immutable ECS fallback frontend image"
      echo "NEXT_PUBLIC_API_BASE_URL=https://${API_DOMAIN}"
      npm ci --workspace=releviz-web
      npm --workspace=releviz-web run build:amplify
      python3 scripts/ci/validate_amplify_static_export.py --out src/web/out
      echo "${{ env.AMPLIFY_ARTIFACT }}.sha256"
      echo "retention-days: 90"
      echo release.json
      test "$release_sha" = "$DEPLOY_SHA"
      echo "Plan production infrastructure with current DNS state"
      echo 'TF_VAR_frontend_image_tag: ${{ steps.rollback_frontend.outputs.sha }}'
      echo production-base.tfplan
      echo "Verify base ECS services use Terraform-selected task definitions"
      for role in backend result_worker email_worker frontend; do
        echo "$role"
      done
      terraform -chdir=infra/prod output -raw "${role}_task_definition_arn"
      echo '.services[0].taskDefinition == $expected'
"""
                '      echo \'[.services[0].deployments[] | select(.status == "PRIMARY") | '
                ".taskDefinition] == [$expected]'"
                """
      echo 'all(.tasks[]; .lastStatus == "RUNNING" and .taskDefinitionArn == $expected)'
      terraform -chdir=infra/prod state list
      echo "Detect API-subdomain transition state"
      echo "Install reviewed Amplify security headers"
      aws amplify update-app --custom-headers "$custom_headers"
      echo "TF_VAR_amplify_app_id: ${{ vars.PROD_AMPLIFY_APP_ID }}"
      aws amplify get-domain-association
      terraform -chdir=infra/prod state pull
      echo '.status // "ready"'
      terraform -chdir=infra/prod untaint 'aws_amplify_domain_association.frontend[0]'
      echo "Recovered the verified Amplify domain association from tainted Terraform state"
"""
                "      terraform -chdir=infra/prod import "
                "'aws_amplify_domain_association.frontend[0]' \"${app_id}/${domain_name}\""
                """
      echo "Recovered the existing Amplify domain association into Terraform state"
      echo "Capture pre-release canonical Route53 alias"
      echo "bash scripts/deploy/amplify-apex-target.sh"
      echo "Guard live Amplify configuration before candidate smoke"
      terraform -chdir=infra/prod show -json production-base.tfplan
      echo 'address == "aws_amplify_app.frontend"'
      echo 'address == "aws_amplify_branch.production"'
      echo 'address == "aws_amplify_domain_association.frontend[0]"'
      echo "DOMAIN_PREEXISTING then CANONICAL_ROUTES_TO_ALB"
      echo "Move the canonical alias to the documented ECS fallback"
      aws route53 list-resource-record-sets
      echo AliasTarget
      echo routes_to_alb
      echo '${alias_target#dualstack.}'
      echo "neither the managed ALB fallback nor Amplify's exact reported apex target"
      echo "TF_VAR_enable_amplify_domain: ${{ steps.domain_state.outputs.preexisting }}"
      echo amplify_default_domain
      echo "Run pre-Amplify backend smoke tests"
  - name: Ensure production default administrator through one-off ECS task
    run: |
      started_by="admin-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
      echo "started_by=${started_by}" >>"$GITHUB_OUTPUT"
      terraform -chdir=infra/prod output -raw default_admin_task_definition_arn
      task_definition_state="$(aws ecs describe-task-definition)"
      jq -e \
        --arg password_secret "${TF_VAR_default_admin_password_secret_arn}:password::" '
          .taskDefinition.family == "releviz-prod-default-admin-task"
          and .taskDefinition.containerDefinitions[0].command
            == ["python", "manage.py", "ensure_default_admin", "--yes", "--create-only"]
          and (
            .taskDefinition.containerDefinitions[0].environment[]
            | select(.name == "DJANGO_SKIP_STARTUP_TASKS" and .value == "1")
          )
          and (
            .taskDefinition.containerDefinitions[0].environment[]
            | select(.name == "DJANGO_CREATE_DEFAULT_ADMIN" and .value == "0")
          )
          and (
            .taskDefinition.containerDefinitions[0].secrets[]
            | select(
                .name == "DJANGO_SUPERUSER_PASSWORD"
                and .valueFrom == $password_secret
              )
          )
        ' <<<"$task_definition_state"
      aws ecs describe-services
      echo 'networkConfiguration.awsvpcConfiguration'
      echo 'assignPublicIp == "DISABLED"'
      backend_task_state="$(
        aws ecs describe-task-definition \
          --task-definition "$backend_task_definition"
      )"
      jq -e '
        all(
          .taskDefinition.containerDefinitions[].secrets[]?;
          .name != "DJANGO_SUPERUSER_PASSWORD"
        )
        and all(
          .taskDefinition.containerDefinitions[].environment[]?;
          .name != "DJANGO_SUPERUSER_EMAIL"
        )
      ' <<<"$backend_task_state"
      default_admin_image="immutable-backend-image"
      backend_image="immutable-backend-image"
      if [ "$default_admin_image" != "$backend_image" ]; then exit 1; fi
      aws ecs list-tasks \
        --cluster "$CLUSTER_NAME" \
        --started-by "$started_by"
      aws ecs run-task \
        --cluster "$CLUSTER_NAME" \
        --launch-type FARGATE \
        --task-definition "$expected_task_definition" \
        --network-configuration "$network_configuration" \
        --count 1 \
        --started-by "$started_by" \
        --tags \
          key=Project,value=releviz \
          key=Environment,value=prod \
          key=Purpose,value=default-admin-bootstrap \
        --output json
      timeout --signal=TERM 900s \
        aws ecs wait tasks-stopped \
          --cluster "$CLUSTER_NAME" \
          --tasks "$task_arn"
      stopped_state="$(
        aws ecs describe-tasks \
          --cluster "$CLUSTER_NAME" \
          --tasks "$task_arn"
      )"
      jq -e '
        .tasks[0].taskDefinitionArn == $expected
        and .tasks[0].lastStatus == "STOPPED"
        and .tasks[0].containers[0].exitCode == 0
      ' <<<"$stopped_state"
  - name: Clean up an interrupted default-administrator task
    if: ${{ always() && steps.default_admin.outputs.started_by != '' }}
    run: |
      aws ecs list-tasks \
        --cluster "$CLUSTER_NAME" \
        --started-by "$DEFAULT_ADMIN_STARTED_BY"
      aws ecs stop-task \
        --cluster "$CLUSTER_NAME" \
        --task "$task_arn"
      timeout --signal=TERM 180s \
        aws ecs wait tasks-stopped \
          --cluster "$CLUSTER_NAME" \
          --tasks "$task_arn"
  - run: |
      echo "Fail closed when an Amplify release job is active"
      for branch in "$CANDIDATE_BRANCH" "$PRODUCTION_BRANCH"; do
        echo '"CREATED" "PENDING" "PROVISIONING" "RUNNING" "CANCELLING"'
      done
      echo "Capture current Amplify production rollback point"
      echo "Resolve retained Amplify rollback artifact"
      artifact_name="releviz-amplify-${PREVIOUS_SHA}"
      gh api --method GET --paginate --slurp \
        "repos/${GITHUB_REPOSITORY}/actions/artifacts"
      echo '.name == $artifact_name'
      echo '.expired == false'
      echo '.workflow_run.head_sha == $sha'
      echo '.workflow_run.head_branch == "main"'
      echo '.path == ".github/workflows/deploy-prod.yml"'
      echo '.event == "workflow_dispatch"'
      echo '.status == "completed"'
      echo '.head_repository.full_name == $GITHUB_REPOSITORY'
      echo "artifact_id=$artifact_id"
      echo "run_id=$run_id"
      echo "Download retained Amplify rollback artifact"
      echo "uses: actions/download-artifact@v8"
      echo "artifact-ids: $artifact_id"
      echo "github-token: ${{ github.token }}"
      echo "repository: ${{ github.repository }}"
      echo "run-id: $run_id"
      echo "digest-mismatch: error"
      echo "path: ${{ runner.temp }}/amplify-rollback"
      echo "Verify retained Amplify rollback artifact"
      echo 'if [ "${#retained_entries[@]}" -ne 2 ]; then exit 1; fi'
      echo '[[ "$checksum_line" =~ ^([0-9a-f]{64})[[:space:]]{2}(.+)$ ]]'
      echo '[ "${BASH_REMATCH[2]}" = "$expected_archive" ]'
      sha256sum --check --strict --status checksum.sha256
      unzip -tq "$ROLLBACK_ARCHIVE"
      zipinfo -1 "$ROLLBACK_ARCHIVE"
      echo "Reject unsafe path"
      if [ "$(grep -cx 'release.json' "$zip_entries")" -ne 1 ]; then exit 1; fi
      unzip -p "$ROLLBACK_ARCHIVE" release.json |
        jq -e --arg sha "$PREVIOUS_SHA" '.sha == $sha'
      echo "Deploy candidate Amplify branch"
      scripts/deploy/amplify-static-deploy.sh
      echo "Smoke candidate Amplify frontend and direct API boundary"
      candidate_security_headers="${RUNNER_TEMP}/candidate-security.headers"
      curl --dump-header "$candidate_security_headers" "${candidate_url}/"
      echo "strict-transport-security: max-age=31536000; includeSubDomains"
      echo "x-content-type-options: nosniff"
      echo "x-frame-options: DENY"
      echo "referrer-policy: no-referrer"
      echo "^content-security-policy:"
      echo "connect-src 'self' https://${API_DOMAIN}"
      jq -r '.static_routes[]' src/web/amplify-routes.json
      jq -r '.legacy_redirects | keys[]' src/web/amplify-routes.json
      echo 'event/?code=AMPLIFYSMOKE'
      find src/web/out/_next/static
      echo "Access-Control-Request-Method: PUT"
      echo "access-control-allow-origin"
      echo '${api_url}/admin/login/'
      echo '<form'
      echo csrfmiddlewaretoken
      echo '${api_url}/static/admin/css/base.css'
      echo 'if [ "$admin_post_status" != "200" ] && [ "$admin_post_status" != "400" ]; then'
      echo 'PUT /authn/profile'
      echo 'DELETE /authn/sessions'
      echo "Revalidate Amplify production rollback point"
      echo "Require a safe live-branch mutation budget"
      echo 'JOB_STARTED_AT: ${{ steps.job_budget.outputs.started_at }}'
      now="$(date +%s)"
      elapsed=$((now - JOB_STARTED_AT))
      remaining=$((PRODUCTION_JOB_TIMEOUT_SECONDS - elapsed))
      rollback_reserve=$((90 * 60))
      if [ "$remaining" -lt "$rollback_reserve" ]; then
        exit 1
      fi
      echo "Deploy production Amplify branch"
      echo "Smoke production Amplify branch before domain cutover"
      phase_deadline=$((SECONDS + 600))
      bounded_curl() {
        local remaining=$((phase_deadline - SECONDS))
        if [ "$remaining" -le 0 ]; then return 124; fi
        timeout --signal=TERM "${remaining}s" curl "$@"
      }
      jq -r '.static_routes[]' src/web/amplify-routes.json
      find src/web/out/_next/static
      if ((SECONDS >= phase_deadline)); then exit 1; fi
      canonical_preflight_headers="${RUNNER_TEMP}/canonical-api-preflight.headers"
      canonical_preflight_status="$(
        curl \
          --request OPTIONS \
          --header "Origin: https://${PROD_DOMAIN}" \
          --header "Access-Control-Request-Method: PUT" \
          --header "Access-Control-Request-Headers: authorization,content-type" \
          --dump-header "$canonical_preflight_headers" \
          --write-out "%{http_code}" \
          "https://${API_DOMAIN}/authn/profile/"
      )"
      if [ "$canonical_preflight_status" != "200" ] ||
        ! grep -Fqi "access-control-allow-origin: https://${PROD_DOMAIN}" \
          "$canonical_preflight_headers" ||
        ! grep -qiE 'access-control-allow-credentials: true' \
          "$canonical_preflight_headers"; then
        exit 1
      fi
      echo "Verify preserved canonical alias immediately before cutover"
      echo "refusing cutover"
      echo "Plan reviewed Amplify domain association"
      echo 'TF_VAR_enable_amplify_domain: "true"'
      echo 'TF_VAR_frontend_image_tag: ${{ steps.rollback_frontend.outputs.sha }}'
      terraform -chdir=infra/prod show -json production-domain.tfplan
      echo '.change.actions | index("delete")) == null'
      echo "Require a safe first-cutover time budget"
      echo "if: ${{ steps.apex_alias.outputs.routes_to_alb == 'true' }}"
      echo 'JOB_STARTED_AT: ${{ steps.job_budget.outputs.started_at }}'
      now="$(date +%s)"
      elapsed=$((now - JOB_STARTED_AT))
      remaining=$((PRODUCTION_JOB_TIMEOUT_SECONDS - elapsed))
      compensation_reserve=$((70 * 60))
      if [ "$remaining" -lt "$compensation_reserve" ]; then
        exit 1
      fi
      echo "Apply exact Amplify domain association plan"
      echo "Reconcile Amplify domain association for a migration retry"
      aws amplify update-domain-association
      echo "Wait for Amplify custom domain availability"
      echo "Verify Amplify canonical DNS cutover"
      echo "bash scripts/deploy/amplify-apex-target.sh"
      echo expected_amplify_target
      echo "The canonical alias did not match Amplify's exact apex DNS target"
      aws elbv2 describe-target-health
      echo "Run canonical production smoke tests"
      phase_deadline=$((SECONDS + 600))
      bounded_curl() {
        local remaining=$((phase_deadline - SECONDS))
        if [ "$remaining" -le 0 ]; then return 124; fi
        timeout --signal=TERM "${remaining}s" curl "$@"
      }
      if ((SECONDS >= phase_deadline)); then exit 1; fi
      canonical_security_headers="${RUNNER_TEMP}/canonical-security.headers"
      curl --dump-header "$canonical_security_headers" "https://${PROD_DOMAIN}/"
      echo "strict-transport-security: max-age=31536000; includeSubDomains"
      echo "x-content-type-options: nosniff"
      echo "x-frame-options: DENY"
      echo "referrer-policy: no-referrer"
      echo "^content-security-policy:"
      echo "connect-src 'self' https://${API_DOMAIN}"
      canonical_preflight_headers="${RUNNER_TEMP}/canonical-api-preflight.headers"
      canonical_preflight_status="$(
        curl \
          --request OPTIONS \
          --header "Origin: https://${PROD_DOMAIN}" \
          --header "Access-Control-Request-Method: PUT" \
          --header "Access-Control-Request-Headers: authorization,content-type" \
          --dump-header "$canonical_preflight_headers" \
          --write-out "%{http_code}" \
          "https://${API_DOMAIN}/authn/profile/"
      )"
      if [ "$canonical_preflight_status" != "200" ] ||
        ! grep -Fqi "access-control-allow-origin: https://${PROD_DOMAIN}" \
          "$canonical_preflight_headers" ||
        ! grep -qiE 'access-control-allow-credentials: true' \
          "$canonical_preflight_headers"; then
        exit 1
      fi
      echo "Plan final production topology"
      echo 'TF_VAR_frontend_image_tag: ${{ github.sha }}'
      echo 'TF_VAR_enable_legacy_api_compatibility: "false"'
      echo production-final.tfplan
      account_id="$(aws sts get-caller-identity --query Account --output text)"
      expected_frontend_image="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_FRONTEND}:${DEPLOY_SHA}"
      unexpected_changes="$(
        echo '--arg frontend_image "$expected_frontend_image"'
        echo 'def backend_proxy_source:'
        echo 'def reviewed_backend_rule:'
        echo 'def prune_unknown:'
        echo 'def normalized_task:'
        echo '.ipc_mode = (.ipc_mode // "")'
        echo '.pid_mode = (.pid_mode // "")'
        echo '.task_role_arn = (.task_role_arn // "")'
        echo 'def named_entries_are_unique:'
        echo 'def normalized_backend_container:'
        echo '.environment |= (map(.) | sort_by(.name))'
        echo '.secrets |= sort_by(.name)'
        echo 'def normalized_frontend_container:'
        echo '.environment |= (map(.) | sort_by(.name))'
        echo '$before_container.environment | named_entries_are_unique'
        echo '$after_container.environment | named_entries_are_unique'
        echo '$before_container.secrets | named_entries_are_unique'
        echo '$after_container.secrets | named_entries_are_unique'
        echo '$before_containers[0].environment | named_entries_are_unique'
        echo '$after_containers[0].environment | named_entries_are_unique'
        echo 'def backend_final_values_are_safe:'
        echo 'def frontend_final_values_are_safe:'
        echo '.resource_changes[]?'
        echo 'select(.change.actions != ["no-op"])'
        echo 'del(.custom_rule)'
        echo '. == "/api"'
        echo '. == "/authn"'
        echo '. == "/admin"'
        echo '. == "/static"'
        echo 'startswith("/api/")'
        echo '.target | startswith($legacy_origin_url + "/")'
        echo '.status == "200"'
        echo '.change.after_unknown | prune_unknown'
        echo 'del(.ecs_target[0].task_definition_arn)'
        echo 'del(.task_definition)'
        echo 'del(.health_check[0].path)'
        echo '.change.before.health_check[0].path != "/api/health"'
        echo '.change.after.health_check[0].path != "/health"'
        echo 'ENABLE_LEGACY_API_PREFIX == "0"'
        echo 'BACKEND_URL == $api_url'
        echo '$container.image == $frontend_image'
        echo '$actions != ["update"]'
        echo '($actions | sort) != ["create", "delete"]'
        echo '$actions != ["delete"]'
        echo '"aws_amplify_app.frontend"'
        echo '"aws_cloudwatch_event_target.event_reminders"'
        echo '"aws_ecs_service.backend"'
        echo '"aws_ecs_service.result_worker"'
        echo '"aws_ecs_service.email_worker"'
        echo '"aws_ecs_service.frontend"'
        echo '"aws_lb_target_group.backend"'
        echo '"aws_ecs_task_definition.backend"'
        echo '"aws_ecs_task_definition.result_worker"'
        echo '"aws_ecs_task_definition.email_worker"'
        echo '"aws_ecs_task_definition.frontend"'
        echo '"aws_acm_certificate.origin[0]"'
        echo '"aws_acm_certificate_validation.origin[0]"'
        echo '"aws_lb_listener_certificate.origin[0]"'
        echo '"aws_lb_listener_rule.backend[0]"'
        echo '"aws_route53_record.origin[0]"'
        echo '"aws_route53_record.origin_cert_validation["'
        echo 'else true end'
      )"
      if [ "$unexpected_changes" != "[]" ]; then
        task_definition_diagnostics="$(
          echo 'before_environment_order:'
          echo 'before_optional_task_strings:'
          echo 'remaining_after_unknown:'
        )"
        exit 1
      fi
      echo "Apply exact final production topology plan"
      terraform -chdir=infra/prod apply -input=false production-final.tfplan
      echo "Verify final API-only backend topology"
      account_id="$(aws sts get-caller-identity --query Account --output text)"
      expected_backend_image="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_BACKEND}:${DEPLOY_SHA}"
      expected_frontend_image="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_FRONTEND}:${DEPLOY_SHA}"
      backend_task_definition="$(
        aws ecs describe-services \
          --services "${{ steps.terraform.outputs.backend_service }}" \
          --query "services[0].taskDefinition"
      )"
      expected_backend_task_definition="$(
        terraform -chdir=infra/prod output -raw backend_task_definition_arn
      )"
      if [ "$backend_task_definition" != "$expected_backend_task_definition" ]; then
        exit 1
      fi
      backend_image="$(
        aws ecs describe-task-definition \
          --task-definition "$backend_task_definition" \
          --query "taskDefinition.containerDefinitions[0].image"
      )"
      if [ "$backend_image" != "$expected_backend_image" ]; then exit 1; fi
      for role in result_worker email_worker; do
        echo "$role"
      done
      echo '["python","manage.py","recompute_event_results","--watch","--poll-interval=1"]'
      echo '["python","manage.py","dispatch_email_jobs","--watch","--limit=1000","--concurrency=10","--rate-limit=10","--poll-interval=1"]'
      echo '.taskDefinition.containerDefinitions[0].stopTimeout == 120'
      echo '.taskDefinition.containerDefinitions[0].healthCheck.retries == 3'
      echo 'DJANGO_MIGRATE_ON_START and .value == "1"'
      frontend_task_definition="$(
        aws ecs describe-services \
          --services "${{ steps.terraform.outputs.frontend_service }}" \
          --query "services[0].taskDefinition"
      )"
      expected_frontend_task_definition="$(
        terraform -chdir=infra/prod output -raw frontend_task_definition_arn
      )"
      if [ "$frontend_task_definition" != "$expected_frontend_task_definition" ]; then
        exit 1
      fi
      frontend_image="$(
        aws ecs describe-task-definition \
          --task-definition "$frontend_task_definition" \
          --query "taskDefinition.containerDefinitions[0].image"
      )"
      if [ "$frontend_image" != "$expected_frontend_image" ]; then exit 1; fi
      event_targets="$(
        aws events list-targets-by-rule \
          --output json
      )"
      if ! jq -e \
        --arg expected "$expected_backend_task_definition" \
        '(.Targets | length) == 1
          and .Targets[0].EcsParameters.TaskDefinitionArn == $expected' \
          <<<"$event_targets" >/dev/null; then
        exit 1
      fi
      final_preflight_headers="${RUNNER_TEMP}/final-api-preflight.headers"
      final_preflight_status="$(
        curl \
          --request OPTIONS \
          --header "Origin: https://${PROD_DOMAIN}" \
          --header "Access-Control-Request-Method: PUT" \
          --header "Access-Control-Request-Headers: authorization,content-type" \
          --dump-header "$final_preflight_headers" \
          --write-out "%{http_code}" \
          "https://${API_DOMAIN}/authn/profile/"
      )"
      if [ "$final_preflight_status" != "200" ] ||
        ! grep -Fqi "access-control-allow-origin: https://${PROD_DOMAIN}" \
          "$final_preflight_headers" ||
        ! grep -qiE 'access-control-allow-credentials: true' \
          "$final_preflight_headers"; then
        exit 1
      fi
      echo 'https://${API_DOMAIN}/api/health'
      legacy_urls=(
        "https://${PROD_DOMAIN}/api/health"
        "https://${PROD_DOMAIN}/admin/"
        "https://${PROD_DOMAIN}/authn/public-key/"
        "https://${PROD_DOMAIN}/static/admin/css/base.css"
        "https://${API_DOMAIN}/api/health"
      )
      stable_retired_cycles=0
      for attempt in $(seq 1 30); do
        all_retired=true
        for legacy_url in "${legacy_urls[@]}"; do
          echo "Cache-Control: no-cache"
          echo "Pragma: no-cache"
          probe_result="$(
            curl \
              --location \
              --max-redirs 5 \
              --write-out $'%{http_code}\\t%{url_effective}' \
              "${legacy_url}?retired_check=${DEPLOY_SHA}-${attempt}"
          )"
          status="${probe_result%%$'\\t'*}"
          effective_url="${probe_result#*$'\\t'}"
          if [[ "$legacy_url" == "https://${PROD_DOMAIN}/"* ]]; then
            expected_origin="https://${PROD_DOMAIN}/"
          elif [[ "$legacy_url" == "https://${API_DOMAIN}/"* ]]; then
            expected_origin="https://${API_DOMAIN}/"
          else
            expected_origin=""
          fi
          if [ "$status" != "404" ] ||
            [ -z "$expected_origin" ] ||
            [[ "$effective_url" != "${expected_origin}"* ]]; then
            all_retired=false
          fi
        done
        if [ "$all_retired" = "true" ]; then
          stable_retired_cycles=$((stable_retired_cycles + 1))
          if [ "$stable_retired_cycles" -ge 3 ]; then break; fi
        else
          stable_retired_cycles=0
        fi
      done
      if [ "$stable_retired_cycles" -lt 3 ]; then exit 1; fi
      echo "Restore pre-release canonical Route53 alias after failed first cutover"
      echo "steps.canonical_smoke.outcome != 'success'"
      association_terminal=false
      for attempt in $(seq 1 120); do
        aws amplify get-domain-association
        echo '.domainAssociation.domainStatus'
        echo '.domainAssociation.updateStatus'
        domain_status="AVAILABLE"
        update_status="NONE"
        if { [ "$domain_status" = "AVAILABLE" ] &&
          [[ "$update_status" =~ ^(NONE|UPDATE_COMPLETE)$ ]]; } ||
          [ "$update_status" = "UPDATE_FAILED" ] ||
          { [ "$domain_status" = "FAILED" ] && [ "$update_status" = "NONE" ]; }; then
          association_terminal=true
          break
        elif grep -q 'NotFoundException' "$association_error"; then
          association_terminal=true
          break
        fi
      done
      if [ "$association_terminal" != "true" ]; then exit 1; fi
      restore_canonical_alias() {
        aws route53 change-resource-record-sets
      }
      stable_alias_checks=0
      for attempt in $(seq 1 12); do
        if [ "$actual_alias" = "$expected_alias" ]; then
          stable_alias_checks=$((stable_alias_checks + 1))
          if [ "$stable_alias_checks" -ge 6 ]; then break; fi
        elif is_recognized_amplify_alias "$actual_alias"; then
          restore_canonical_alias
          stable_alias_checks=0
        else
          exit 1
        fi
      done
      if [ "$stable_alias_checks" -lt 6 ]; then exit 1; fi
      aws route53 change-resource-record-sets
      echo 'Action: "UPSERT"'
      aws route53 wait resource-record-sets-changed
      echo AMPLIFY_ALIAS_FILE
      echo "bash scripts/deploy/amplify-apex-target.sh"
      echo "refusing to overwrite it"
      echo "Roll back production Amplify branch after failed release"
      echo "steps.apex_alias.outputs.routes_to_alb != 'true'"
      echo "steps.production_deploy.outputs.terminal_confirmed == 'true'"
      echo 'API_COMPATIBILITY: ${{ steps.api_transition.outputs.compatibility }}'
      scripts/deploy/amplify-static-deploy.sh \
        "$AMPLIFY_APP_ID" "$PRODUCTION_BRANCH" "$ROLLBACK_ARCHIVE"
      production_url="https://${PRODUCTION_BRANCH}.${AMPLIFY_DEFAULT_DOMAIN}"
      phase_deadline=$((SECONDS + 300))
      bounded_curl() {
        local remaining=$((phase_deadline - SECONDS))
        if [ "$remaining" -le 0 ]; then return 124; fi
        timeout --signal=TERM "${remaining}s" curl "$@"
      }
      if ((SECONDS >= phase_deadline)); then exit 1; fi
      for base_url in "$production_url" "https://${PROD_DOMAIN}"; do
        curl "${base_url}/"
        curl "${base_url}/release.json" | jq -er .sha
        test "$release_sha" = "$PREVIOUS_SHA"
      done
      for path in /health/live /health /admin/ /static/admin/css/base.css; do
        curl "https://${API_DOMAIN}${path}"
      done
      if [ "$API_COMPATIBILITY" = "true" ]; then
        for base_url in "$production_url" "https://${PROD_DOMAIN}"; do
          for path in /api/health/live /api/health /admin/; do
            curl "${base_url}${path}"
          done
        done
      else
        for base_url in "$production_url" "https://${PROD_DOMAIN}"; do
          for path in /api/health /admin/; do
            status="$(curl "${base_url}${path}")"
            if [ "$status" != "404" ]; then exit 1; fi
          done
        done
      fi
      echo "Summarize immutable production release"
""",
                encoding="utf-8",
            )
            self.assertEqual(production_cd_errors(root), [])
            protected_source = workflow.read_text(encoding="utf-8")

            default_admin_guards = (
                (
                    "terraform -chdir=infra/prod output -raw default_admin_task_definition_arn",
                    "echo unreviewed-default-admin-task",
                    "production CD omits the Terraform-selected default-admin task definition",
                ),
                (
                    '--network-configuration "$network_configuration"',
                    '--network-configuration "awsvpcConfiguration={assignPublicIp=ENABLED}"',
                    "production CD omits exactly one private Fargate default-admin task",
                ),
                (
                    "timeout --signal=TERM 900s",
                    "timeout --signal=TERM 0s",
                    "production CD omits a bounded stopped-state wait for the default-admin task",
                ),
                (
                    ".tasks[0].containers[0].exitCode == 0",
                    ".tasks[0].containers[0].exitCode != 0",
                    (
                        "production CD omits stopped-task dataflow and successful container "
                        "exit verification"
                    ),
                ),
                (
                    "[$django, $field, $metrics, $admin]",
                    "[$django, $field, $metrics]",
                    "production CD omits a four-way production application-secret uniqueness guard",
                ),
                (
                    '"releviz/prod/default-admin-password"',
                    '"releviz/prod/other-secret"',
                    "production CD omits an exact default-admin Secrets Manager name guard",
                ),
                (
                    "${TF_VAR_default_admin_password_secret_arn}:password::",
                    "${TF_VAR_default_admin_password_secret_arn}:wrong::",
                    "production CD omits the default-admin JSON password-key selector",
                ),
                (
                    'echo "started_by=${started_by}" >>"$GITHUB_OUTPUT"',
                    'echo "started_by=${started_by}"',
                    "production CD omits a persisted unique default-admin started-by token",
                ),
                (
                    '--started-by "$started_by"',
                    '--started-by "not-the-recorded-token"',
                    "production CD omits started-by discovery for interrupted default-admin tasks",
                ),
                (
                    "key=Purpose,value=default-admin-bootstrap",
                    "key=Purpose,value=unreviewed",
                    "production CD omits the three required default-admin task tags",
                ),
                (
                    "--count 1",
                    "--count 1\n        --overrides '{}'",
                    "production CD must not override roles or commands on the default-admin task",
                ),
                (
                    'if [ "$default_admin_image" != "$backend_image" ]; then exit 1; fi',
                    'if [ "$default_admin_image" = "$backend_image" ]; then exit 1; fi',
                    "production CD omits runtime equality of the default-admin and backend images",
                ),
                (
                    '<<<"$backend_task_state"',
                    '<<<"$task_definition_state"',
                    (
                        "production CD omits runtime isolation of administrator inputs from "
                        "the deployed backend task"
                    ),
                ),
                (
                    "steps.default_admin.outputs.started_by != ''",
                    "steps.default_admin.outputs.started_by == ''",
                    "production CD omits an always-run started-by cleanup guard",
                ),
                (
                    '--started-by "$DEFAULT_ADMIN_STARTED_BY"',
                    '--started-by "unreviewed"',
                    "production CD omits compensating discovery of interrupted default-admin tasks",
                ),
                (
                    "aws ecs stop-task",
                    "aws ecs describe-tasks",
                    "production CD omits compensating stop of interrupted default-admin tasks",
                ),
                (
                    "timeout --signal=TERM 180s",
                    "timeout --signal=TERM 0s",
                    (
                        "production CD omits bounded verification of compensating "
                        "default-admin cleanup"
                    ),
                ),
            )
            for needle, replacement, expected_error in default_admin_guards:
                with self.subTest(expected_error=expected_error):
                    self.assertIn(needle, protected_source)
                    workflow.write_text(
                        protected_source.replace(needle, replacement, 1),
                        encoding="utf-8",
                    )
                    self.assertIn(expected_error, production_cd_errors(root))

            workflow.write_text(
                protected_source.replace(
                    "- name: Record production job time budget",
                    "- name: Record production job time budget too late",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD does not record the job epoch in its first step",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "timeout-minutes: 160",
                    "timeout-minutes: 120",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits the reviewed 160-minute production job limit",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    'PRODUCTION_JOB_TIMEOUT_SECONDS: "9600"',
                    'PRODUCTION_JOB_TIMEOUT_SECONDS: "7200"',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits the production job timeout in seconds",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    'AMPLIFY_TIMEOUT_SECONDS: "1200"',
                    'AMPLIFY_TIMEOUT_SECONDS: "1800"',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits the bounded Amplify deployment-helper timeout",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "rollback_reserve=$((90 * 60))",
                    "rollback_reserve=$((30 * 60))",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits the 5,400-second live-branch rollback reserve",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "steps.apex_alias.outputs.routes_to_alb == 'true'",
                    "steps.apex_alias.outputs.routes_to_alb != 'true'",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits ALB-only first-cutover budget enforcement",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "compensation_reserve=$((70 * 60))",
                    "compensation_reserve=$((30 * 60))",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits the 4,200-second DNS-compensation reserve",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "Plan reviewed Amplify domain association",
                    "__DOMAIN_PLAN_MARKER__",
                    1,
                )
                .replace(
                    "Require a safe first-cutover time budget",
                    "Plan reviewed Amplify domain association",
                    1,
                )
                .replace(
                    "__DOMAIN_PLAN_MARKER__",
                    "Require a safe first-cutover time budget",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD must place the first-cutover budget guard after "
                "the domain plan and before its apply",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    '      echo "Apply exact Amplify domain association plan"',
                    "      - name: Unreviewed step between cutover guard and apply\n"
                    '      echo "Apply exact Amplify domain association plan"',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD must place the first-cutover budget guard "
                "immediately before the domain apply",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "phase_deadline=$((SECONDS + 600))",
                    "phase_deadline=$((SECONDS + 900))",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits a 600-second hard deadline in production branch smoke",
                production_cd_errors(root),
            )

            canonical_smoke_position = protected_source.index(
                "Run canonical production smoke tests"
            )
            canonical_deadline_source = protected_source[
                :canonical_smoke_position
            ] + protected_source[canonical_smoke_position:].replace(
                "phase_deadline=$((SECONDS + 600))",
                "phase_deadline=$((SECONDS + 900))",
                1,
            )
            workflow.write_text(canonical_deadline_source, encoding="utf-8")
            self.assertIn(
                "production CD omits a 600-second hard deadline in canonical production smoke",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "phase_deadline=$((SECONDS + 300))",
                    "phase_deadline=$((SECONDS + 600))",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits a 300-second hard deadline in rollback smoke",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "echo '$container.image == $frontend_image'",
                    "echo 'endswith($frontend_image)'",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits exact frontend image equality in the final task",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    'if [ "$backend_image" != "$expected_backend_image" ]; then',
                    'if [ "$backend_image" != "$DEPLOY_SHA" ]; then',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits exact backend runtime image equality",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "(.Targets | length) == 1",
                    "(.Targets | length) >= 1",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits exactly one EventBridge reminder target",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    ".Targets[0].EcsParameters.TaskDefinitionArn == $expected",
                    ".Targets[0].EcsParameters.TaskDefinitionArn != $expected",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits exact reminder-target backend task-definition ARN equality",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    '--header "Origin: https://${PROD_DOMAIN}"',
                    '--header "Origin: https://wrong.example"',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits the canonical frontend origin in "
                "production branch pre-cutover CORS preflight",
                production_cd_errors(root),
            )

            canonical_cors_source = protected_source[:canonical_smoke_position] + protected_source[
                canonical_smoke_position:
            ].replace(
                '--header "Access-Control-Request-Method: PUT"',
                '--header "Access-Control-Request-Method: GET"',
                1,
            )
            workflow.write_text(canonical_cors_source, encoding="utf-8")
            self.assertIn(
                "production CD omits the protected PUT request method in "
                "canonical post-cutover CORS preflight",
                production_cd_errors(root),
            )

            final_marker_position = protected_source.index("Verify final API-only backend topology")
            final_cors_source = protected_source[:final_marker_position] + protected_source[
                final_marker_position:
            ].replace(
                "access-control-allow-credentials: true",
                "access-control-allow-credentials: false",
                1,
            )
            workflow.write_text(final_cors_source, encoding="utf-8")
            self.assertIn(
                "production CD omits credentialed CORS enforcement in "
                "final API topology CORS preflight",
                production_cd_errors(root),
            )

            compensated = protected_source.replace(
                "aws route53 change-resource-record-sets",
                "echo missing-route53-compensation",
            )
            workflow.write_text(compensated, encoding="utf-8")
            self.assertIn(
                "production CD omits an atomic Route53 alias restoration",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace('"CANCELLING"', '"CANCELLED"'),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits all non-terminal Amplify job-state guards",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "terraform -chdir=infra/prod import",
                    "echo missing-orphan-import",
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits orphan Amplify domain-association recovery",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "Guard live Amplify configuration before candidate smoke",
                    "missing-live-configuration-guard",
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits a pre-candidate guard for live Amplify configuration",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "terraform -chdir=infra/prod untaint",
                    "echo missing-safe-untaint",
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits verified tainted-domain recovery during detection",
                production_cd_errors(root),
            )

            marker = "Wait for Amplify custom domain availability"
            next_marker = "Verify Amplify canonical DNS cutover"
            workflow.write_text(
                protected_source.replace(marker, "__WAIT_MARKER__", 1)
                .replace(next_marker, marker, 1)
                .replace("__WAIT_MARKER__", next_marker, 1),
                encoding="utf-8",
            )
            self.assertIn(
                (
                    "production CD must resolve and verify rollback artifacts before candidate, "
                    "production, and custom-domain stages"
                ),
                production_cd_errors(root),
            )

            required_api_topology_contract = (
                (
                    'echo "Plan production infrastructure with current DNS state"\n'
                    "      echo 'TF_VAR_frontend_image_tag: "
                    "${{ steps.rollback_frontend.outputs.sha }}'",
                    'echo "Plan production infrastructure with current DNS state"\n'
                    "      echo 'TF_VAR_frontend_image_tag: ${{ github.sha }}'",
                    "production CD omits the deployed ECS frontend SHA in the base Terraform plan",
                ),
                (
                    'echo "Plan reviewed Amplify domain association"\n'
                    "      echo 'TF_VAR_enable_amplify_domain: \"true\"'\n"
                    "      echo 'TF_VAR_frontend_image_tag: "
                    "${{ steps.rollback_frontend.outputs.sha }}'",
                    'echo "Plan reviewed Amplify domain association"\n'
                    "      echo 'TF_VAR_enable_amplify_domain: \"true\"'\n"
                    "      echo 'TF_VAR_frontend_image_tag: ${{ github.sha }}'",
                    (
                        "production CD omits the deployed ECS frontend SHA in the domain "
                        "Terraform plan"
                    ),
                ),
                (
                    "echo 'TF_VAR_frontend_image_tag: ${{ github.sha }}'\n"
                    "      echo 'TF_VAR_enable_legacy_api_compatibility: \"false\"'\n"
                    "      echo production-final.tfplan",
                    "echo 'TF_VAR_frontend_image_tag: "
                    "${{ steps.rollback_frontend.outputs.sha }}'\n"
                    "      echo 'TF_VAR_enable_legacy_api_compatibility: \"false\"'\n"
                    "      echo production-final.tfplan",
                    "production CD omits the current frontend SHA in the final Terraform plan",
                ),
                (
                    "echo \"steps.canonical_smoke.outcome != 'success'\"",
                    "echo \"steps.canonical_smoke.outcome == 'success'\"",
                    (
                        "production CD omits a canonical-smoke failure guard on first-cutover "
                        "DNS compensation"
                    ),
                ),
                (
                    "      echo '<form'\n",
                    "",
                    "production CD omits the Django admin login form in candidate smoke",
                ),
                (
                    "      echo '${api_url}/static/admin/css/base.css'\n",
                    "",
                    "production CD omits the direct Django admin static asset in candidate smoke",
                ),
                (
                    '        curl "https://${API_DOMAIN}${path}"',
                    '        curl "${base_url}${path}"',
                    "production CD omits the API subdomain boundary in rollback smoke",
                ),
                (
                    "for path in /api/health /admin/; do",
                    "for path in /api/health; do",
                    "production CD omits retired frontend backend-route checks in rollback smoke",
                ),
            )
            for needle, replacement, expected_error in required_api_topology_contract:
                with self.subTest(expected_error=expected_error):
                    self.assertIn(needle, protected_source)
                    workflow.write_text(
                        protected_source.replace(needle, replacement, 1),
                        encoding="utf-8",
                    )
                    self.assertIn(expected_error, production_cd_errors(root))

            retired_redirect_contract = (
                (
                    "--location",
                    "--no-location",
                    "production CD omits bounded redirect following for retired routes",
                ),
                (
                    "--max-redirs 5",
                    "--max-redirs 50",
                    "production CD omits a five-redirect ceiling for retired routes",
                ),
                (
                    "%{http_code}\\t%{url_effective}",
                    "%{http_code}",
                    "production CD omits terminal retired-route status and effective URL capture",
                ),
                (
                    'expected_origin="https://${PROD_DOMAIN}/"',
                    'expected_origin="http://${PROD_DOMAIN}/"',
                    "production CD omits the canonical frontend same-origin boundary",
                ),
                (
                    'expected_origin="https://${API_DOMAIN}/"',
                    'expected_origin="http://${API_DOMAIN}/"',
                    "production CD omits the canonical API same-origin boundary",
                ),
                (
                    '[ -z "$expected_origin" ]',
                    '[ -n "$expected_origin" ]',
                    "production CD omits fail-closed unknown retired-route origin handling",
                ),
                (
                    '[[ "$effective_url" != "${expected_origin}"* ]]',
                    '[[ "$effective_url" == "${expected_origin}"* ]]',
                    "production CD omits same-origin terminal redirect enforcement",
                ),
            )
            for needle, replacement, expected_error in retired_redirect_contract:
                with self.subTest(expected_error=expected_error):
                    self.assertIn(needle, protected_source)
                    workflow.write_text(
                        protected_source.replace(needle, replacement, 1),
                        encoding="utf-8",
                    )
                    self.assertIn(expected_error, production_cd_errors(root))

            reviewed_response_headers = (
                (
                    "strict-transport-security: max-age=31536000; includeSubDomains",
                    "missing-strict-transport-security",
                    "Strict-Transport-Security",
                ),
                (
                    "x-content-type-options: nosniff",
                    "missing-x-content-type-options",
                    "X-Content-Type-Options",
                ),
                (
                    "x-frame-options: DENY",
                    "missing-x-frame-options",
                    "X-Frame-Options",
                ),
                (
                    "referrer-policy: no-referrer",
                    "missing-referrer-policy",
                    "Referrer-Policy",
                ),
                (
                    "^content-security-policy:",
                    "missing-content-security-policy",
                    "Content-Security-Policy",
                ),
            )
            for needle, replacement, header in reviewed_response_headers:
                with self.subTest(response_header=header):
                    self.assertEqual(protected_source.count(needle), 2)
                    workflow.write_text(
                        protected_source.replace(needle, replacement),
                        encoding="utf-8",
                    )
                    errors = production_cd_errors(root)
                    self.assertIn(
                        (
                            f"production CD omits the {header} check on actual candidate "
                            "Amplify responses"
                        ),
                        errors,
                    )
                    self.assertIn(
                        (
                            f"production CD omits the {header} check on actual canonical "
                            "Amplify responses"
                        ),
                        errors,
                    )

            workflow.write_text(
                protected_source.replace(
                    'curl --dump-header "$candidate_security_headers" "${candidate_url}/"',
                    'curl "${candidate_url}/"',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits actual candidate Amplify response-header capture",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    '"aws_lb_target_group.backend"',
                    '"aws_lb_target_group.unreviewed"',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                (
                    "production CD final plan does not use the exact reviewed "
                    "unexpected_changes address allowlist"
                ),
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    '      unexpected_changes="$(',
                    '      unchecked_changes="$(',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits an unexpected_changes result",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "        else\n          stable_retired_cycles=0",
                    "        else\n          stable_retired_cycles=1",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD does not reset retired-route stability after a non-404 cycle",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "          restore_canonical_alias\n          stable_alias_checks=0",
                    "          restore_canonical_alias\n          stable_alias_checks=1",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD does not reset DNS compensation stability after an alias rewrite",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "        aws amplify get-domain-association",
                    "        echo missing-domain-association-poll",
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits Amplify association polling before DNS compensation",
                production_cd_errors(root),
            )

            for marker in (
                "Plan final production topology",
                "Apply exact final production topology plan",
                "Verify final API-only backend topology",
            ):
                with self.subTest(unconditional_final_step=marker):
                    workflow.write_text(
                        protected_source.replace(
                            f'echo "{marker}"\n',
                            f'echo "{marker}"\n'
                            "      if: ${{ steps.api_transition.outputs.compatibility "
                            "== 'true' }}\n",
                            1,
                        ),
                        encoding="utf-8",
                    )
                    self.assertIn(
                        f"production CD conditionally skips {marker}",
                        production_cd_errors(root),
                    )

            workflow.write_text(
                protected_source.replace(
                    'echo \'if [ "$admin_post_status" != "200" ] && '
                    '[ "$admin_post_status" != "400" ]; then\'',
                    'if [ "$admin_post_status" != "400" ]; then',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD retains an exclusive custom 400 Django admin contract",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    "      echo '<form'\n",
                    "      echo '<form'\n"
                    '      echo "Please enter valid staff account credentials."\n',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD retains a custom Django admin error-message contract",
                production_cd_errors(root),
            )

            required_rollback_contract = (
                (
                    "  actions: read\n",
                    "",
                    "production CD omits GitHub Actions artifact read permission",
                ),
                (
                    'echo "retention-days: 90"',
                    'echo "retention-days: 7"',
                    "production CD omits a 90-day rollback artifact retention window",
                ),
                (
                    'artifact_name="releviz-amplify-${PREVIOUS_SHA}"',
                    'artifact_name="untrusted-${PREVIOUS_SHA}"',
                    "production CD omits an exact previous-SHA rollback artifact name",
                ),
                (
                    "--paginate --slurp",
                    "--paginate",
                    "production CD omits complete paginated rollback artifact discovery",
                ),
                (
                    ".name == $artifact_name",
                    ".name != $artifact_name",
                    "production CD omits exact rollback artifact-name matching",
                ),
                (
                    ".expired == false",
                    ".expired == true",
                    "production CD omits an unexpired rollback-artifact requirement",
                ),
                (
                    ".workflow_run.head_sha == $sha",
                    ".workflow_run.head_sha != $sha",
                    "production CD omits rollback artifact head-SHA binding",
                ),
                (
                    '.workflow_run.head_branch == "main"',
                    '.workflow_run.head_branch == "feature"',
                    "production CD omits rollback artifact main-branch binding",
                ),
                (
                    '.path == ".github/workflows/deploy-prod.yml"',
                    '.path == ".github/workflows/other.yml"',
                    "production CD omits rollback artifact production-workflow binding",
                ),
                (
                    '.event == "workflow_dispatch"',
                    '.event == "push"',
                    "production CD omits rollback artifact workflow-dispatch binding",
                ),
                (
                    '.status == "completed"',
                    '.status == "in_progress"',
                    "production CD omits a completed trusted rollback workflow run",
                ),
                (
                    ".head_repository.full_name == $GITHUB_REPOSITORY",
                    ".head_repository.full_name == $UNTRUSTED_REPOSITORY",
                    "production CD omits rollback artifact source-repository binding",
                ),
                (
                    "uses: actions/download-artifact@v8",
                    "uses: actions/download-artifact@v7",
                    "production CD omits the reviewed cross-run artifact downloader",
                ),
                (
                    "artifact-ids: $artifact_id",
                    "name: $artifact_name",
                    "production CD omits rollback download by immutable artifact ID",
                ),
                (
                    "github-token: ${{ github.token }}",
                    "token: ${{ github.token }}",
                    "production CD omits authenticated cross-run artifact download",
                ),
                (
                    "repository: ${{ github.repository }}",
                    "source: ${{ github.repository }}",
                    "production CD omits an exact rollback artifact repository",
                ),
                (
                    "run-id: $run_id",
                    "run-name: $run_id",
                    "production CD omits an exact rollback artifact workflow run",
                ),
                (
                    "digest-mismatch: error",
                    "digest-mismatch: warn",
                    "production CD omits fail-closed GitHub artifact digest validation",
                ),
                (
                    "path: ${{ runner.temp }}/amplify-rollback",
                    "path: ./rollback",
                    "production CD omits an isolated rollback artifact download directory",
                ),
                (
                    'if [ "${#retained_entries[@]}" -ne 2 ]; then exit 1; fi',
                    'if [ "${#retained_entries[@]}" -eq 0 ]; then exit 1; fi',
                    "production CD omits an exact two-file retained artifact payload",
                ),
                (
                    '[[ "$checksum_line" =~ ^([0-9a-f]{64})[[:space:]]{2}(.+)$ ]]',
                    '[[ -n "$checksum_line" ]]',
                    "production CD omits a strict rollback checksum digest format",
                ),
                (
                    '[ "${BASH_REMATCH[2]}" = "$expected_archive" ]',
                    'echo "skip checksum filename verification"',
                    "production CD omits an exact rollback checksum filename",
                ),
                (
                    "sha256sum --check --strict --status checksum.sha256",
                    "sha256sum checksum.sha256",
                    "production CD omits strict inner rollback ZIP checksum verification",
                ),
                (
                    'unzip -tq "$ROLLBACK_ARCHIVE"',
                    'echo "skip ZIP integrity verification"',
                    "production CD omits inner rollback ZIP integrity verification",
                ),
                (
                    'zipinfo -1 "$ROLLBACK_ARCHIVE"',
                    'echo "skip ZIP entry verification"',
                    "production CD omits inner rollback ZIP entry validation",
                ),
                (
                    'echo "Reject unsafe path"',
                    'echo "Allow unsafe entries"',
                    "production CD omits unsafe inner rollback ZIP path rejection",
                ),
                (
                    "grep -cx 'release.json'",
                    "grep -c 'release.json'",
                    "production CD omits exactly one root rollback release manifest",
                ),
                (
                    'unzip -p "$ROLLBACK_ARCHIVE" release.json |',
                    'echo "{\\"sha\\": \\"unverified\\"}" |',
                    "production CD omits inner rollback release-SHA verification",
                ),
                (
                    'for base_url in "$production_url" "https://${PROD_DOMAIN}"; do',
                    'for base_url in "$production_url"; do',
                    (
                        "production CD omits rollback release identity checks on both default "
                        "and production domains"
                    ),
                ),
            )
            for needle, replacement, expected_error in required_rollback_contract:
                with self.subTest(expected_error=expected_error):
                    workflow.write_text(
                        protected_source.replace(needle, replacement),
                        encoding="utf-8",
                    )
                    self.assertIn(expected_error, production_cd_errors(root))

            before_rollback_helper, separator, after_rollback_helper = protected_source.rpartition(
                "scripts/deploy/amplify-static-deploy.sh"
            )
            self.assertTrue(separator)
            workflow.write_text(
                before_rollback_helper
                + "echo missing-manual-rollback-helper"
                + after_rollback_helper,
                encoding="utf-8",
            )
            self.assertIn(
                "production CD omits manual redeployment of the verified rollback artifact",
                production_cd_errors(root),
            )

            workflow.write_text(
                protected_source.replace(
                    'echo "Roll back production Amplify branch after failed release"',
                    "aws amplify start-job --job-type RETRY\n"
                    '      echo "Roll back production Amplify branch after failed release"',
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "production CD retains unsupported Amplify StartJob retry rollback",
                production_cd_errors(root),
            )

            workflow.write_text("name: Deploy\n", encoding="utf-8")
            self.assertIn("production CD omits manual dispatch", production_cd_errors(root))

    def test_production_cd_rejects_legacy_dns_and_requires_api_aware_frontend_docker(
        self,
    ):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github/workflows"
            workflows.mkdir(parents=True)
            (workflows / "deploy-prod.yml").write_text(
                """
TF_VAR_manage_dns: "false"
run: docker build --tag demo ./src/web
TF_VAR_restrict_origin_to_cloudfront: "true"
TF_VAR_trust_cloudfront_proxy_chain: "true"
echo "Plan CloudFront-only origin hardening"
echo "Plan trusted CloudFront proxy chain"
echo "Restore pre-release origin safety state after failure"
terraform -chdir=infra/prod plan -out=production-restore-origin.tfplan
""",
                encoding="utf-8",
            )
            errors = production_cd_errors(root)
            self.assertIn("production CD retains legacy DNS-disable cutover flow", errors)
            self.assertIn(
                "production CD omits an API-aware ECS frontend fallback build",
                errors,
            )
            self.assertIn(
                "production CD omits the API subdomain baked into the ECS frontend fallback",
                errors,
            )
            self.assertIn(
                "production CD retains retired CloudFront origin-hardening input",
                errors,
            )
            self.assertIn(
                "production CD retains retired CloudFront proxy-chain input",
                errors,
            )
            self.assertIn(
                "production CD retains retired CloudFront-only origin hardening",
                errors,
            )
            self.assertIn(
                "production CD retains retired CloudFront proxy-chain rollout",
                errors,
            )
            self.assertIn(
                "production CD retains retired CloudFront origin-safety restoration",
                errors,
            )
            self.assertIn(
                "production CD retains retired CloudFront origin-safety restore state",
                errors,
            )

    def test_amplify_deploy_script_contract(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "scripts/deploy/amplify-static-deploy.sh"
            script.parent.mkdir(parents=True)
            script.write_text(
                """
aws amplify create-deployment
helper_started_seconds=$SECONDS
AMPLIFY_UPLOAD_CONNECT_TIMEOUT_SECONDS=10
AMPLIFY_UPLOAD_MAX_TIME_SECONDS=300
AMPLIFY_UPLOAD_RETRY_MAX_TIME_SECONDS=300
deadline=$((helper_started_seconds + timeout_seconds))
echo "Amplify upload maximum and retry time must fit within the overall timeout"
curl --connect-timeout 10 --max-time 300 --retry-max-time 300 --upload-file artifact.zip
aws amplify start-deployment
aws amplify get-job
aws amplify stop-job
stop_attempts="${AMPLIFY_STOP_ATTEMPTS:-5}"
cancel_polls_per_attempt="${AMPLIFY_CANCEL_POLLS_PER_ATTEMPT:-12}"
cancel_poll_seconds="${AMPLIFY_CANCEL_POLL_SECONDS:-5}"
AMPLIFY_CANCELLATION_UNCONFIRMED_EXIT_CODE=75
echo "$GITHUB_OUTPUT terminal_confirmed cancellation_confirmed"
echo "Do not start a retry or rollback job"
trap 'exit 130' INT
trap 'exit 143' TERM
case "$status" in
  SUCCEED) exit 0 ;;
  FAILED | CANCELLED) exit 1 ;;
esac
echo "Timed out waiting"
""",
                encoding="utf-8",
            )
            self.assertEqual(amplify_deploy_script_errors(root), [])

            bounded_helper = script.read_text(encoding="utf-8")
            script.write_text(
                bounded_helper.replace(
                    'cancel_poll_seconds="${AMPLIFY_CANCEL_POLL_SECONDS:-5}"',
                    'cancel_poll_seconds="${AMPLIFY_CANCEL_POLL_SECONDS:-10}"',
                    1,
                ),
                encoding="utf-8",
            )
            self.assertIn(
                "manual Amplify deployment helper omits five-second cancellation polling",
                amplify_deploy_script_errors(root),
            )

            script.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            self.assertIn(
                "manual Amplify deployment helper omits create-deployment call",
                amplify_deploy_script_errors(root),
            )

    def test_amplify_deploy_helper_uploads_starts_and_polls(self):
        repository_root = Path(__file__).resolve().parents[3]
        helper = repository_root / "scripts/deploy/amplify-static-deploy.sh"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            aws_log = root / "aws.log"
            curl_log = root / "curl.log"
            output = root / "github-output"
            status_count = root / "status-count"
            archive = root / "frontend.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("index.html", "<!doctype html>")

            fake_aws = fake_bin / "aws"
            fake_aws.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$FAKE_AWS_LOG"
if [[ "$*" == "amplify create-deployment"* ]]; then
  printf '%s\n' '{"jobId":"42","zipUploadUrl":"https://upload.invalid/presigned"}'
elif [[ "$*" == "amplify get-job"* ]]; then
  count=0
  if [ -f "$FAKE_STATUS_COUNT" ]; then count="$(cat "$FAKE_STATUS_COUNT")"; fi
  count=$((count + 1))
  echo "$count" >"$FAKE_STATUS_COUNT"
  if [ "$count" -eq 1 ]; then echo RUNNING; else echo SUCCEED; fi
fi
""",
                encoding="utf-8",
            )
            fake_curl = fake_bin / "curl"
            fake_curl.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$FAKE_CURL_LOG"
""",
                encoding="utf-8",
            )
            fake_sleep = fake_bin / "sleep"
            fake_sleep.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            for executable in (fake_aws, fake_curl, fake_sleep):
                executable.chmod(0o755)

            environment = os.environ.copy()
            environment.update(
                {
                    "PATH": f"{fake_bin}:{environment['PATH']}",
                    "FAKE_AWS_LOG": str(aws_log),
                    "FAKE_CURL_LOG": str(curl_log),
                    "FAKE_STATUS_COUNT": str(status_count),
                    "GITHUB_OUTPUT": str(output),
                    "AMPLIFY_POLL_SECONDS": "1",
                    "AMPLIFY_TIMEOUT_SECONDS": "30",
                    "AMPLIFY_UPLOAD_CONNECT_TIMEOUT_SECONDS": "1",
                    "AMPLIFY_UPLOAD_MAX_TIME_SECONDS": "5",
                    "AMPLIFY_UPLOAD_RETRY_MAX_TIME_SECONDS": "5",
                }
            )
            result = subprocess.run(
                [str(helper), "dexample123", "candidate", str(archive)],
                check=False,
                capture_output=True,
                env=environment,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("amplify create-deployment", aws_log.read_text())
            self.assertIn("amplify start-deployment", aws_log.read_text())
            self.assertIn("amplify get-job", aws_log.read_text())
            self.assertIn("--upload-file", curl_log.read_text())
            self.assertIn("--connect-timeout 1", curl_log.read_text())
            self.assertIn("--max-time 5", curl_log.read_text())
            self.assertIn("--retry-max-time 5", curl_log.read_text())
            self.assertEqual(
                output.read_text(encoding="utf-8"),
                "job_id=42\n"
                "status=SUCCEED\n"
                "terminal_confirmed=true\n"
                "cancellation_confirmed=false\n",
            )

    def test_amplify_deploy_helper_rejects_invalid_upload_timeouts(self):
        repository_root = Path(__file__).resolve().parents[3]
        helper = repository_root / "scripts/deploy/amplify-static-deploy.sh"
        with TemporaryDirectory() as directory:
            archive = Path(directory) / "frontend.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("index.html", "<!doctype html>")

            invalid_environments = (
                (
                    {"AMPLIFY_UPLOAD_CONNECT_TIMEOUT_SECONDS": "0"},
                    "must be positive integers",
                ),
                (
                    {
                        "AMPLIFY_UPLOAD_CONNECT_TIMEOUT_SECONDS": "2",
                        "AMPLIFY_UPLOAD_MAX_TIME_SECONDS": "1",
                    },
                    "connect timeout must not exceed",
                ),
                (
                    {
                        "AMPLIFY_TIMEOUT_SECONDS": "10",
                        "AMPLIFY_UPLOAD_CONNECT_TIMEOUT_SECONDS": "1",
                        "AMPLIFY_UPLOAD_MAX_TIME_SECONDS": "6",
                        "AMPLIFY_UPLOAD_RETRY_MAX_TIME_SECONDS": "5",
                    },
                    "must fit within the overall timeout",
                ),
            )
            for overrides, expected_error in invalid_environments:
                with self.subTest(overrides=overrides):
                    environment = os.environ.copy()
                    environment.update(overrides)
                    result = subprocess.run(
                        [str(helper), "dexample123", "main", str(archive)],
                        check=False,
                        capture_output=True,
                        env=environment,
                        text=True,
                    )
                    self.assertEqual(result.returncode, 64)
                    self.assertIn(expected_error, result.stderr)

    def test_amplify_deploy_helper_cancels_after_upload_timeout(self):
        repository_root = Path(__file__).resolve().parents[3]
        helper = repository_root / "scripts/deploy/amplify-static-deploy.sh"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            aws_log = root / "aws.log"
            curl_log = root / "curl.log"
            output = root / "github-output"
            stopped = root / "stopped"
            archive = root / "frontend.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("index.html", "<!doctype html>")

            fake_aws = fake_bin / "aws"
            fake_aws.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$FAKE_AWS_LOG"
if [[ "$*" == "amplify create-deployment"* ]]; then
  printf '%s\n' '{"jobId":"45","zipUploadUrl":"https://upload.invalid/presigned"}'
elif [[ "$*" == "amplify stop-job"* ]]; then
  touch "$FAKE_STOPPED"
elif [[ "$*" == "amplify get-job"* ]]; then
  if [ -f "$FAKE_STOPPED" ]; then echo CANCELLED; else echo CREATED; fi
fi
""",
                encoding="utf-8",
            )
            fake_curl = fake_bin / "curl"
            fake_curl.write_text(
                '#!/usr/bin/env bash\necho "$*" >"$FAKE_CURL_LOG"\nexit 28\n',
                encoding="utf-8",
            )
            for executable in (fake_aws, fake_curl):
                executable.chmod(0o755)

            environment = os.environ.copy()
            environment.update(
                {
                    "PATH": f"{fake_bin}:{environment['PATH']}",
                    "FAKE_AWS_LOG": str(aws_log),
                    "FAKE_CURL_LOG": str(curl_log),
                    "FAKE_STOPPED": str(stopped),
                    "GITHUB_OUTPUT": str(output),
                    "AMPLIFY_TIMEOUT_SECONDS": "10",
                    "AMPLIFY_UPLOAD_CONNECT_TIMEOUT_SECONDS": "1",
                    "AMPLIFY_UPLOAD_MAX_TIME_SECONDS": "2",
                    "AMPLIFY_UPLOAD_RETRY_MAX_TIME_SECONDS": "2",
                    "AMPLIFY_CANCEL_POLL_SECONDS": "1",
                }
            )
            result = subprocess.run(
                [str(helper), "dexample123", "main", str(archive)],
                check=False,
                capture_output=True,
                env=environment,
                text=True,
            )

            self.assertEqual(result.returncode, 28, result.stderr)
            self.assertIn("--connect-timeout 1", curl_log.read_text())
            self.assertIn("--max-time 2", curl_log.read_text())
            self.assertIn("--retry-max-time 2", curl_log.read_text())
            self.assertIn("amplify stop-job", aws_log.read_text())
            self.assertNotIn("amplify start-deployment", aws_log.read_text())
            self.assertIn("status=CANCELLED", output.read_text())

    def test_amplify_deploy_helper_retries_stop_and_confirms_timed_out_job(self):
        repository_root = Path(__file__).resolve().parents[3]
        helper = repository_root / "scripts/deploy/amplify-static-deploy.sh"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            aws_log = root / "aws.log"
            output = root / "github-output"
            archive = root / "frontend.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("index.html", "<!doctype html>")

            fake_aws = fake_bin / "aws"
            fake_aws.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$FAKE_AWS_LOG"
if [[ "$*" == "amplify create-deployment"* ]]; then
  printf '%s\n' '{"jobId":"43","zipUploadUrl":"https://upload.invalid/presigned"}'
elif [[ "$*" == "amplify get-job"* ]]; then
  if [ -f "$FAKE_STOPPED" ]; then echo CANCELLED; else echo RUNNING; fi
elif [[ "$*" == "amplify stop-job"* ]]; then
  count=0
  if [ -f "$FAKE_STOP_COUNT" ]; then count="$(cat "$FAKE_STOP_COUNT")"; fi
  count=$((count + 1))
  echo "$count" >"$FAKE_STOP_COUNT"
  if [ "$count" -eq 1 ]; then exit 1; fi
  touch "$FAKE_STOPPED"
fi
""",
                encoding="utf-8",
            )
            fake_curl = fake_bin / "curl"
            fake_curl.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            for executable in (fake_aws, fake_curl):
                executable.chmod(0o755)

            environment = os.environ.copy()
            environment.update(
                {
                    "PATH": f"{fake_bin}:{environment['PATH']}",
                    "FAKE_AWS_LOG": str(aws_log),
                    "FAKE_STOPPED": str(root / "stopped"),
                    "FAKE_STOP_COUNT": str(root / "stop-count"),
                    "GITHUB_OUTPUT": str(output),
                    "AMPLIFY_POLL_SECONDS": "1",
                    "AMPLIFY_TIMEOUT_SECONDS": "3",
                    "AMPLIFY_UPLOAD_CONNECT_TIMEOUT_SECONDS": "1",
                    "AMPLIFY_UPLOAD_MAX_TIME_SECONDS": "1",
                    "AMPLIFY_UPLOAD_RETRY_MAX_TIME_SECONDS": "1",
                    "AMPLIFY_STOP_ATTEMPTS": "3",
                    "AMPLIFY_CANCEL_POLLS_PER_ATTEMPT": "1",
                    "AMPLIFY_CANCEL_POLL_SECONDS": "1",
                }
            )
            result = subprocess.run(
                [str(helper), "dexample123", "main", str(archive)],
                check=False,
                capture_output=True,
                env=environment,
                text=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Timed out waiting", result.stderr)
            self.assertEqual(aws_log.read_text().count("amplify stop-job"), 2)
            self.assertIn(
                "Amplify deployment is terminal: branch=main, job=43, status=CANCELLED",
                result.stderr,
            )
            self.assertEqual(
                output.read_text(encoding="utf-8"),
                "job_id=43\n"
                "status=CANCELLED\n"
                "terminal_confirmed=true\n"
                "cancellation_confirmed=true\n",
            )

    def test_amplify_deploy_helper_hard_fails_when_cancellation_is_unconfirmed(self):
        repository_root = Path(__file__).resolve().parents[3]
        helper = repository_root / "scripts/deploy/amplify-static-deploy.sh"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            aws_log = root / "aws.log"
            output = root / "github-output"
            archive = root / "frontend.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("index.html", "<!doctype html>")

            fake_aws = fake_bin / "aws"
            fake_aws.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$FAKE_AWS_LOG"
if [[ "$*" == "amplify create-deployment"* ]]; then
  printf '%s\n' '{"jobId":"44","zipUploadUrl":"https://upload.invalid/presigned"}'
elif [[ "$*" == "amplify start-deployment"* ]]; then
  exit 1
elif [[ "$*" == "amplify get-job"* ]]; then
  echo RUNNING
elif [[ "$*" == "amplify stop-job"* ]]; then
  exit 1
fi
""",
                encoding="utf-8",
            )
            fake_curl = fake_bin / "curl"
            fake_curl.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            fake_sleep = fake_bin / "sleep"
            fake_sleep.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            for executable in (fake_aws, fake_curl, fake_sleep):
                executable.chmod(0o755)

            environment = os.environ.copy()
            environment.update(
                {
                    "PATH": f"{fake_bin}:{environment['PATH']}",
                    "FAKE_AWS_LOG": str(aws_log),
                    "GITHUB_OUTPUT": str(output),
                    "AMPLIFY_STOP_ATTEMPTS": "2",
                    "AMPLIFY_CANCEL_POLLS_PER_ATTEMPT": "1",
                    "AMPLIFY_CANCEL_POLL_SECONDS": "1",
                }
            )
            result = subprocess.run(
                [str(helper), "dexample123", "main", str(archive)],
                check=False,
                capture_output=True,
                env=environment,
                text=True,
            )

            self.assertEqual(result.returncode, 75)
            self.assertEqual(aws_log.read_text().count("amplify stop-job"), 2)
            self.assertIn("branch=main, job=44, last_status=RUNNING", result.stderr)
            self.assertIn("Do not start a retry or rollback job", result.stderr)
            self.assertEqual(
                output.read_text(encoding="utf-8"),
                "job_id=44\n"
                "status=RUNNING\n"
                "terminal_confirmed=false\n"
                "cancellation_confirmed=false\n",
            )


class ProductionCdResolutionTests(TestCase):
    """A parked production CD stays under contract without becoming dispatchable."""

    def workflows(self, root: Path) -> Path:
        workflows = root / ".github/workflows"
        workflows.mkdir(parents=True)
        return workflows

    def test_missing_production_cd_is_reported(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.workflows(root)
            self.assertIsNone(production_cd_path(root))
            self.assertEqual(
                production_cd_errors(root),
                ["production CD workflow is missing"],
            )

    def test_parked_production_cd_is_validated(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            parked = self.workflows(root) / "deploy-prod.yml.disabled"
            parked.write_text("on:\n  workflow_dispatch:\n", encoding="utf-8")

            self.assertEqual(production_cd_path(root), parked)
            errors = production_cd_errors(root)
            self.assertNotIn("production CD workflow is missing", errors)
            # A parked definition is still held to the release invariants.
            self.assertIn(
                "production CD omits the reviewed 160-minute production job limit",
                errors,
            )

    def test_active_production_cd_wins_over_parked(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = self.workflows(root)
            active = workflows / "deploy-prod.yml"
            active.write_text("on:\n  workflow_dispatch:\n", encoding="utf-8")
            (workflows / "deploy-prod.yml.disabled").write_text(
                "on:\n  workflow_dispatch:\n",
                encoding="utf-8",
            )

            self.assertEqual(production_cd_path(root), active)

    def test_repository_parks_production_cd_under_contract(self):
        self.assertEqual(
            production_cd_path().name,
            "deploy-prod.yml.disabled",
            "production CD is expected to stay parked until CD is enabled",
        )
        self.assertEqual(production_cd_errors(), [])
