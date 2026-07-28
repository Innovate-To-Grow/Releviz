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
    production_cd_errors,
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
            self.assertEqual(
                check_budgets(assets, max_total_bytes=20, max_file_bytes=10), []
            )
            self.assertEqual(
                len(check_budgets(assets, max_total_bytes=14, max_file_bytes=9)), 2
            )


class LicenseReportTests(TestCase):
    def test_package_inventory_ignores_workspace_links(self):
        lock = {
            "packages": {
                "": {"name": "root"},
                "src/frontend": {"link": True},
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
            self.assertIn(
                "Amplify static export has no _next/static JavaScript asset", errors
            )


class AmplifyApexTargetTests(TestCase):
    script = (
        Path(__file__).resolve().parents[3]
        / "scripts"
        / "deploy"
        / "amplify-apex-target.sh"
    )

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
    def test_production_alb_security_group_is_in_place_only(self):
        source = """
resource "aws_security_group" "alb" {
  name        = "releviz-prod-alb-sg"
  description = "Allow public HTTP and HTTPS ingress to the load balancer"

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
  id-token: write
steps:
  - uses: hashicorp/setup-terraform@v4
    with:
      terraform_wrapper: false
  - run: |
      if [ "$CONFIRMATION" != "DEPLOY" ]; then exit 1; fi
      git rev-parse HEAD
      echo "CI Result"
      echo "TF_VAR_backend_image_tag: $DEPLOY_SHA"
      aws ecs describe-task-definition
      echo "TF_VAR_frontend_image_tag=$rollback_sha"
      npm ci --workspace=releviz-frontend
      npm --workspace=releviz-frontend run build:amplify
      python3 scripts/ci/validate_amplify_static_export.py --out src/frontend/out
      echo "${{ env.AMPLIFY_ARTIFACT }}.sha256"
      echo release.json
      test "$release_sha" = "$DEPLOY_SHA"
      terraform -chdir=infra/prod state list
      terraform -chdir=infra/prod output -raw origin_restricted_to_cloudfront
      terraform -chdir=infra/prod output -raw trust_cloudfront_proxy_chain
      echo "TF_VAR_amplify_app_id: ${{ vars.PROD_AMPLIFY_APP_ID }}"
      aws amplify get-domain-association
      terraform -chdir=infra/prod state pull
      echo '.status // "ready"'
      terraform -chdir=infra/prod untaint 'aws_amplify_domain_association.frontend[0]'
      echo "Recovered the verified Amplify domain association from tainted Terraform state"
      terraform -chdir=infra/prod import 'aws_amplify_domain_association.frontend[0]' "${app_id}/${domain_name}"
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
      echo "An ALB canonical alias requires public ingress and one-hop proxy trust"
      echo "TF_VAR_enable_amplify_domain: ${{ steps.domain_state.outputs.preexisting }}"
      echo "TF_VAR_restrict_origin_to_cloudfront: ${{ steps.origin_state.outputs.preexisting }}"
      echo "TF_VAR_trust_cloudfront_proxy_chain: ${{ steps.proxy_state.outputs.preexisting }}"
      echo amplify_default_domain
      echo "Fail closed when an Amplify release job is active"
      for branch in "$CANDIDATE_BRANCH" "$PRODUCTION_BRANCH"; do
        echo '"CREATED" "PENDING" "PROVISIONING" "RUNNING" "CANCELLING"'
      done
      echo "Capture current Amplify production rollback point"
      echo "Deploy candidate Amplify branch"
      scripts/deploy/amplify-static-deploy.sh
      echo "Smoke candidate Amplify frontend and same-origin proxy"
      jq -r '.static_routes[]' src/frontend/amplify-routes.json
      jq -r '.legacy_redirects | keys[]' src/frontend/amplify-routes.json
      echo 'event/?code=AMPLIFYSMOKE'
      find src/frontend/out/_next/static
      echo csrfmiddlewaretoken
      echo 'email=amplify-smoke-${DEPLOY_SHA}@example.invalid'
      echo 'admin_post_status" != "400"'
      echo "Please enter valid staff account credentials."
      echo 'PUT /authn/profile'
      echo 'DELETE /authn/sessions'
      echo "Deploy production Amplify branch"
      echo "Smoke production Amplify branch before domain cutover"
      jq -r '.static_routes[]' src/frontend/amplify-routes.json
      find src/frontend/out/_next/static
      aws amplify start-job --job-type RETRY
      echo "Verify preserved canonical alias immediately before cutover"
      echo "refusing cutover"
      echo "Plan reviewed Amplify domain association"
      echo 'TF_VAR_enable_amplify_domain: "true"'
      terraform -chdir=infra/prod show -json production-domain.tfplan
      echo '.change.actions | index("delete")) == null'
      echo "Reconcile Amplify domain association for a migration retry"
      aws amplify update-domain-association
      echo "Wait for Amplify custom domain availability"
      echo "Verify Amplify canonical DNS cutover"
      echo "bash scripts/deploy/amplify-apex-target.sh"
      echo expected_amplify_target
      echo "The canonical alias did not match Amplify's exact apex DNS target"
      aws elbv2 describe-target-health
      echo "Run canonical production smoke tests"
      echo "Allow legacy Route53 alias caches to expire"
      echo "Plan CloudFront-only origin hardening"
      echo 'TF_VAR_restrict_origin_to_cloudfront: "true"'
      echo "Verify production through the CloudFront-only origin"
      echo "Plan trusted CloudFront proxy chain"
      echo 'TF_VAR_trust_cloudfront_proxy_chain: "true"'
      echo "Wait for trusted-proxy backend rollout"
      echo "Verify trusted-proxy backend target health"
      echo "Verify production through the trusted CloudFront proxy chain"
      echo "Restore pre-release origin safety state after failure"
      echo "steps.restore_origin_safety.outcome == 'success'"
      terraform -chdir=infra/prod untaint 'aws_amplify_domain_association.frontend[0]'
      terraform -chdir=infra/prod plan -out=production-restore-origin.tfplan
      terraform -chdir=infra/prod show -json production-restore-origin.tfplan
      echo '(.change.actions | index("delete")) == null'
      echo "Restore pre-release canonical Route53 alias after failed first cutover"
      aws route53 change-resource-record-sets
      echo 'Action: "UPSERT"'
      aws route53 wait resource-record-sets-changed
      echo AMPLIFY_ALIAS_FILE
      echo "bash scripts/deploy/amplify-apex-target.sh"
      echo "refusing to overwrite it"
      echo "Roll back production Amplify branch after failed release"
      echo "steps.apex_alias.outputs.routes_to_alb != 'true'"
      echo "steps.production_deploy.outputs.terminal_confirmed == 'true'"
""",
                encoding="utf-8",
            )
            self.assertEqual(production_cd_errors(root), [])
            protected_source = workflow.read_text(encoding="utf-8")

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
                "production CD omits verified tainted-domain recovery during detection or failure restoration",
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
                "production CD must verify candidate, production, custom-domain, and origin-hardening stages in order",
                production_cd_errors(root),
            )

            workflow.write_text("name: Deploy\n", encoding="utf-8")
            self.assertIn(
                "production CD omits manual dispatch", production_cd_errors(root)
            )

    def test_production_cd_rejects_legacy_dns_and_frontend_docker(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github/workflows"
            workflows.mkdir(parents=True)
            (workflows / "deploy-prod.yml").write_text(
                """
TF_VAR_manage_dns: "false"
run: docker build --tag demo ./src/frontend
""",
                encoding="utf-8",
            )
            errors = production_cd_errors(root)
            self.assertIn(
                "production CD retains legacy DNS-disable cutover flow", errors
            )
            self.assertIn(
                "production CD retains a production frontend Docker build", errors
            )

    def test_amplify_deploy_script_contract(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "scripts/deploy/amplify-static-deploy.sh"
            script.parent.mkdir(parents=True)
            script.write_text(
                """
aws amplify create-deployment
curl --upload-file artifact.zip
aws amplify start-deployment
aws amplify get-job
aws amplify stop-job
AMPLIFY_STOP_ATTEMPTS=5
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
            self.assertEqual(
                output.read_text(encoding="utf-8"),
                "job_id=42\n"
                "status=SUCCEED\n"
                "terminal_confirmed=true\n"
                "cancellation_confirmed=false\n",
            )

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
                    "AMPLIFY_TIMEOUT_SECONDS": "1",
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
