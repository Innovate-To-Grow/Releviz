import subprocess
from pathlib import Path
from unittest import TestCase

ROOT = Path(__file__).resolve().parents[3]
LOCK_SCRIPT = ROOT / "scripts/compile-api-requirements.sh"
POSTGRES_ACTION = ROOT / ".github/actions/setup-postgres/action.yml"


class RequirementViaPathTests(TestCase):
    def canonicalize(self, text: str) -> str:
        completed = subprocess.run(
            ["bash", str(LOCK_SCRIPT), "--canonicalize-via"],
            input=text,
            text=True,
            check=True,
            capture_output=True,
        )
        return completed.stdout

    def test_dependabot_via_paths_match_the_repo_lock_script(self):
        committed = "urllib3==2.8.0 \\\n    # via -r src/api/requirements/base.in\n"
        dependabot = "urllib3==2.8.0 \\\n    # via -r base.in\n"
        requirements_dir = "urllib3==2.8.0 \\\n    # via -r requirements/base.in\n"
        canonical = self.canonicalize(committed)
        self.assertEqual(canonical, self.canonicalize(dependabot))
        self.assertEqual(canonical, self.canonicalize(requirements_dir))
        self.assertEqual(canonical, self.canonicalize(canonical))

    def test_local_and_production_inputs_keep_other_via_lines(self):
        canonical = self.canonicalize(
            "    # via -r local.in\n    # via -r production.in\n    # via django\n"
        )
        self.assertIn("# via -r src/api/requirements/local.in", canonical)
        self.assertIn("# via -r src/api/requirements/production.in", canonical)
        self.assertIn("# via django", canonical)


class PostgresSetupTests(TestCase):
    def test_missing_major_is_installed_instead_of_failing_the_job(self):
        source = POSTGRES_ACTION.read_text(encoding="utf-8")
        self.assertIn("apt.postgresql.org", source)
        self.assertIn("postgresql-${PG_MAJOR}", source)
        self.assertIn("pg_ctlcluster", source)
        self.assertIn("expected ${PG_MAJOR}", source)
        self.assertNotIn("Pin runs-on to an image that ships it.", source)
