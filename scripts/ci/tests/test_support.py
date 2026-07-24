import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from scripts.ci.check_bundle_size import check_budgets, collect_assets
from scripts.ci.check_npm_licenses import package_inventory
from scripts.ci.summarize_workflow_jobs import render
from scripts.ci.validate_deployment_contract import (
    CD_DISABLED_MARKER,
    production_cd_disabled_errors,
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
                "frontend": {"link": True},
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


class DeploymentContractTests(TestCase):
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

    def test_production_cd_must_have_only_the_disabled_marker_file(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github/workflows"
            workflows.mkdir(parents=True)
            disabled = workflows / "deploy-prod.yml.disabled"
            disabled.write_text(f"# {CD_DISABLED_MARKER}\n", encoding="utf-8")

            self.assertEqual(production_cd_disabled_errors(root), [])

            (workflows / "deploy-prod.yml").write_text(
                "name: Deploy\n", encoding="utf-8"
            )
            self.assertEqual(
                production_cd_disabled_errors(root),
                ["production CD must remain disabled during PR consolidation"],
            )
