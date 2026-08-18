import re
from pathlib import Path
from unittest import TestCase

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_PATH = ROOT / ".github/workflows/ci.yml"


class FullCIWorkflowTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = WORKFLOW_PATH.read_text(encoding="utf-8")

    def job_block(self, job_name: str) -> str:
        marker = f"\n  {job_name}:\n"
        self.assertIn(marker, self.source)
        remainder = self.source.split(marker, 1)[1]
        next_job = re.search(r"(?m)^  [a-z0-9-]+:\n", remainder)
        return remainder[: next_job.start()] if next_job else remainder

    def test_manual_dispatch_and_full_scope_are_enabled(self):
        self.assertIn("  workflow_dispatch:\n", self.source)
        scope = self.job_block("changes")
        self.assertIn("name: Full CI Scope", scope)
        self.assertEqual(scope.count("      - name:"), 1)
        for area in ("backend", "frontend", "e2e", "infra"):
            self.assertIn(f'echo "{area}=true"', scope)

    def test_workflow_uses_full_django_and_browser_plans(self):
        django_plan = self.job_block("django-test-plan")
        self.assertIn("plan_django_tests.py", django_plan)
        self.assertIn("--full", django_plan)
        self.assertNotIn("--changed-files", django_plan)

        e2e_plan = self.job_block("e2e-plan")
        self.assertIn("plan_e2e_tests.py", e2e_plan)
        self.assertIn("--full", e2e_plan)
        self.assertNotIn("--changed-files", e2e_plan)

    def test_required_results_do_not_accept_skipped_jobs(self):
        self.assertNotIn('{"success", "skipped"}', self.source)
        ci_result = self.job_block("ci-result")
        self.assertIn('data["result"] != "success"', ci_result)

    def test_each_browser_job_installs_only_its_own_runtime(self):
        e2e = self.job_block("e2e")
        self.assertIn("${{ matrix.project }}-cfw", e2e)
        self.assertIn('playwright install --with-deps "$PW_PROJECT"', e2e)
        self.assertIn('playwright install-deps "$PW_PROJECT"', e2e)
        self.assertNotIn("install-deps chromium firefox webkit", e2e)

    def test_python_security_audit_retries_but_still_fails_closed(self):
        audit = self.job_block("python-security-audit")
        self.assertIn("for attempt in 1 2 3", audit)
        self.assertIn("python -m pip_audit", audit)
        self.assertIn("pip-audit failed after 3 attempts", audit)
        self.assertNotIn("|| true", audit)

    def test_every_step_has_an_action_or_command(self):
        step_blocks = re.split(r"(?m)^      - name: ", self.source)[1:]
        self.assertTrue(step_blocks)
        for step in step_blocks:
            step_name = step.splitlines()[0]
            with self.subTest(step=step_name):
                self.assertRegex(step, r"(?m)^        (?:run|uses):")
