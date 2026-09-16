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
    production_default_admin_task_errors,
    production_ecs_task_definition_errors,
    production_proxy_configuration_errors,
    production_release_paths,
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


class ProductionReleaseWorkflowTests(TestCase):
    """The split production releases keep their reviewed safety invariants."""

    RELEASE_FILES = (
        ".github/workflows/release-backend.yml",
        ".github/workflows/release-frontend.yml",
        ".github/workflows/release-infrastructure.yml",
        ".github/actions/release-preflight/action.yml",
        ".github/actions/release-scope/action.yml",
    )

    def copy_release_files(self, root: Path) -> None:
        repository = Path(__file__).resolve().parents[3]
        for relative in self.RELEASE_FILES:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text((repository / relative).read_text(encoding="utf-8"), encoding="utf-8")

    def test_repository_release_workflows_satisfy_contract(self):
        paths = production_release_paths()
        self.assertEqual(
            sorted(paths), ["backend", "frontend", "infrastructure", "preflight", "scope-action"]
        )
        for path in paths.values():
            self.assertTrue(path.exists(), path)
        self.assertEqual(production_cd_errors(), [])

    def test_missing_release_files_are_reported(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            errors = production_cd_errors(root)
            self.assertIn("backend release workflow is missing", errors)
            self.assertIn("frontend release workflow is missing", errors)
            self.assertIn("infrastructure release workflow is missing", errors)
            self.assertIn("release preflight action is missing", errors)
            self.assertIn("release scope action is missing", errors)

    def test_retired_single_release_workflow_is_rejected(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_release_files(root)
            self.assertEqual(production_cd_errors(root), [])
            (root / ".github/workflows/deploy-prod.yml").write_text(
                "on:\n  workflow_dispatch:\n", encoding="utf-8"
            )
            self.assertIn(
                "retired single release workflow remains: .github/workflows/deploy-prod.yml",
                production_cd_errors(root),
            )

    def test_release_invariants_are_detected_when_removed(self):
        self.maxDiff = None
        backend = ".github/workflows/release-backend.yml"
        frontend = ".github/workflows/release-frontend.yml"
        infrastructure = ".github/workflows/release-infrastructure.yml"
        preflight = ".github/actions/release-preflight/action.yml"
        scope = ".github/actions/release-scope/action.yml"
        release_sha = (
            "${{ github.event_name == 'workflow_run' && "
            "github.event.workflow_run.head_sha || github.sha }}"
        )
        mutations = (
            # Every workflow: triggers, gates, and credentials.
            (
                backend,
                "    branches: [main]\n  workflow_dispatch:",
                "    branches: [develop]\n  workflow_dispatch:",
                "backend release omits automatic release requests from CI runs on main",
            ),
            (
                frontend,
                "github.event.workflow_run.event == 'push' &&",
                "github.event.workflow_run.event == 'pull_request' &&",
                "frontend release omits an automatic-release guard for successful push CI "
                "runs on main from this repository",
            ),
            (
                infrastructure,
                "if: ${{ needs.scope.outputs.release == 'true' }}",
                "if: ${{ always() }}",
                "infrastructure release omits a release job that only runs when its scope changed",
            ),
            (
                backend,
                "    environment:\n      name: Production",
                "    environment:\n      name: Staging",
                "backend release omits the Production environment gate",
            ),
            (
                frontend,
                f"DEPLOY_SHA: {release_sha}",
                "DEPLOY_SHA: ${{ github.sha }}",
                "frontend release omits the release commit as the deploy SHA",
            ),
            (
                infrastructure,
                "AWS_ROLE_ARN: ${{ vars.AWS_PROD_ROLE_ARN }}",
                "AWS_ROLE_ARN: ${{ secrets.AWS_PROD_ROLE_ARN }}",
                "infrastructure release retains GitHub secrets (production secrets live in "
                "AWS Secrets Manager)",
            ),
            (
                backend,
                "        with:\n          scope: backend",
                "        with:\n          scope: infrastructure",
                "backend release omits the backend preflight scope",
            ),
            (
                frontend,
                "workflow-file: release-frontend.yml",
                "workflow-file: release-backend.yml",
                "frontend release omits its own workflow file in the scope comparison",
            ),
            (
                infrastructure,
                "cancel-in-progress: false",
                "cancel-in-progress: true",
                "infrastructure release omits non-cancelling release concurrency",
            ),
            # Backend: immutable images, guarded plan, workers, default admin.
            (
                backend,
                f"TF_VAR_backend_image_tag: {release_sha}",
                "TF_VAR_backend_image_tag: latest",
                "backend release omits the release commit as the backend image tag",
            ),
            (
                backend,
                "--image-tag-mutability IMMUTABLE",
                "--image-tag-mutability MUTABLE",
                "backend release omits an immutable ECR repository",
            ),
            (
                backend,
                "-lock-timeout=15m",
                "-lock=false",
                "backend release omits a bounded wait for the remote state lock",
            ),
            (
                backend,
                'or .change.actions == ["delete"]',
                "or false",
                "backend release omits a no-destroy plan guard",
            ),
            (
                backend,
                "apply -input=false -auto-approve backend-release.tfplan",
                "apply -input=false -auto-approve",
                "backend release omits an exact saved-plan apply",
            ),
            (
                backend,
                '"dispatch_email_jobs","--watch","--limit=1000","--concurrency=10",'
                '"--rate-limit=10","--poll-interval=1"',
                '"dispatch_email_jobs","--watch"',
                "backend release omits the exact email-worker command",
            ),
            (
                backend,
                '["python", "manage.py", "ensure_default_admin", "--yes", "--create-only"]',
                '["python", "manage.py", "ensure_default_admin", "--yes"]',
                "backend release omits a create-only default-admin command",
            ),
            (
                backend,
                "timeout --signal=TERM 900s",
                "timeout --signal=TERM 0s",
                "backend release omits a bounded default-admin wait",
            ),
            (
                backend,
                "Clean up an interrupted default-administrator task",
                "Tidy up",
                "backend release omits compensating cleanup of interrupted default-admin tasks",
            ),
            (
                backend,
                'if [ "$status" != "404" ]; then',
                'if [ "$status" != "200" ]; then',
                "backend release omits retired routes returning 404",
            ),
            # Frontend: rollback point, smoke, ordering, rollback.
            (
                frontend,
                "retention-days: 90",
                "retention-days: 1",
                "frontend release omits 90-day rollback artifact retention",
            ),
            (
                frontend,
                "| select(.expired == false)",
                "| select(true)",
                "frontend release omits an unexpired rollback-artifact requirement",
            ),
            (
                frontend,
                '(.event == "workflow_dispatch" or .event == "workflow_run")',
                '(.event == "workflow_dispatch" or .event == "push")',
                "frontend release omits rollback artifact release-event binding",
            ),
            (
                frontend,
                "sha256sum --check --strict",
                "sha256sum",
                "frontend release omits rollback artifact checksum verification",
            ),
            (
                frontend,
                "steps.verify_previous_amplify_artifact.outcome == 'success' &&",
                "true &&",
                "frontend release omits a rollback gated on a verified artifact and a "
                "terminal production job",
            ),
            (
                frontend,
                "csrfmiddlewaretoken",
                "csrf",
                "frontend release omits a CSRF-protected admin POST smoke",
            ),
            (
                frontend,
                'AMPLIFY_TIMEOUT_SECONDS: "1200"',
                'AMPLIFY_TIMEOUT_SECONDS: "60"',
                "frontend release omits the bounded Amplify deployment-helper timeout",
            ),
            # Infrastructure: guarded plan and held images.
            (
                infrastructure,
                "TF_VAR_frontend_image_tag: ${{ steps.images.outputs.frontend }}",
                f"TF_VAR_frontend_image_tag: {release_sha}",
                "infrastructure release omits the resolved fallback frontend tag in the plan",
            ),
            (
                infrastructure,
                'or (.address | startswith("aws_amplify_domain_association."))',
                "or false",
                "infrastructure release omits an untouched Amplify domain",
            ),
            (
                infrastructure,
                "del(.custom_rule)",
                "del(.tags)",
                "infrastructure release omits Amplify app changes limited to redirect rules",
            ),
            # Shared preflight and scope actions.
            (
                preflight,
                '[ "$TRIGGER_EVENT" = "workflow_dispatch" ] && [ "$CONFIRMATION" != "DEPLOY" ]',
                '[ "$CONFIRMATION" = "DEPLOY" ]',
                "release preflight omits the DEPLOY confirmation for manual releases",
            ),
            (
                preflight,
                "role-duration-seconds: 3600",
                "role-duration-seconds: 43200",
                "release preflight omits short-lived release credentials",
            ),
            (
                preflight,
                "aws-actions/configure-aws-credentials@v6.2.2",
                "aws-actions/configure-aws-credentials@v1",
                "release preflight omits OIDC credential exchange",
            ),
            (
                preflight,
                "use_lockfile=true",
                "use_lockfile=false",
                "release preflight omits native Terraform state locking",
            ),
            (
                scope,
                "runs?branch=main&status=success&per_page=1",
                "runs?branch=main&per_page=1",
                "release scope omits the last successful release as the diff base",
            ),
            (
                scope,
                'echo "release=false"',
                'echo "release=true"',
                "release scope omits a skip when nothing changed",
            ),
        )
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_release_files(root)
            originals = {
                relative: (root / relative).read_text(encoding="utf-8")
                for relative in self.RELEASE_FILES
            }
            self.assertEqual(production_cd_errors(root), [])
            for relative, needle, replacement, expected_error in mutations:
                with self.subTest(expected_error=expected_error):
                    self.assertIn(needle, originals[relative], relative)
                    (root / relative).write_text(
                        originals[relative].replace(needle, replacement),
                        encoding="utf-8",
                    )
                    self.assertIn(expected_error, production_cd_errors(root))
                    (root / relative).write_text(originals[relative], encoding="utf-8")

    def test_release_step_order_is_enforced(self):
        frontend = ".github/workflows/release-frontend.yml"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_release_files(root)
            source = (root / frontend).read_text(encoding="utf-8")
            candidate = "      - name: Deploy candidate Amplify branch"
            production = "      - name: Deploy production Amplify branch"
            swapped = (
                source.replace(candidate, "@@candidate@@", 1)
                .replace(production, candidate, 1)
                .replace("@@candidate@@", production, 1)
            )
            (root / frontend).write_text(swapped, encoding="utf-8")
            self.assertIn(
                "frontend release runs its release steps out of the reviewed order",
                production_cd_errors(root),
            )

    def test_release_scope_action_stays_credential_free(self):
        scope = ".github/actions/release-scope/action.yml"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_release_files(root)
            source = (root / scope).read_text(encoding="utf-8")
            (root / scope).write_text(
                source + "\n    - run: aws sts get-caller-identity\n      shell: bash\n",
                encoding="utf-8",
            )
            self.assertIn(
                "release scope must not use cloud credentials",
                production_cd_errors(root),
            )
