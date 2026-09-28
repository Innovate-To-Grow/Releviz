import re
from pathlib import Path
from unittest import TestCase

from scripts.ci.retry_transient_failures import render_summary, retry_decision, transient_errors

ROOT = Path(__file__).resolve().parents[3]
RETRY_WORKFLOW_PATH = ROOT / ".github/workflows/ci-retry.yml"
CI_WORKFLOW_PATH = ROOT / ".github/workflows/ci.yml"

STAMP = "2026-09-28T02:54:31.4264600Z "


class TransientErrorTests(TestCase):
    def test_infrastructure_errors_are_recognised(self):
        samples = {
            "registry rate limit": [
                "Error response from daemon: toomanyrequests: Data limit exceeded",
                "429 Too Many Requests - Server message: toomanyrequests: You have reached "
                "your unauthenticated pull rate limit.",
                "GET https://ghcr.io/v2/aquasecurity/trivy-db/manifests/2: TOOMANYREQUESTS: "
                "retry-after: 191.43µs, allowed: 44000/minute",
            ],
            "npm registry unreachable": [
                "npm error code ECONNRESET",
                "npm ERR! code ETIMEDOUT",
                "npm error network request to https://registry.npmjs.org/next failed",
            ],
            "Python package index unreachable": [
                "ERROR: Could not install packages due to an OSError: HTTPSConnectionPool("
                "host='files.pythonhosted.org', port=443): Max retries exceeded with url: /x",
            ],
            "apt mirror unreachable": [
                "E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/pool/main/x.deb",
            ],
            "browser download failed": [
                "Error: Failed to download WebKit 26.0 (playwright build v2215), caused by",
            ],
            "download failed": [
                "curl: (28) Failed to connect to github.com port 443 after 130000 ms",
                "curl: (6) Could not resolve host: github.com",
            ],
            "GitHub unreachable": [
                "fatal: unable to access 'https://github.com/org/repo/': The requested URL "
                "returned error: 502",
            ],
            "runner lost": [
                "The hosted runner: GitHub Actions 1000001234 lost communication with the server.",
                "##[error]The runner has received a shutdown signal.",
            ],
        }
        for label, lines in samples.items():
            for line in lines:
                with self.subTest(line=line):
                    self.assertEqual(transient_errors(STAMP + line), [label])

    def test_failures_of_the_code_under_test_are_not(self):
        for line in (
            "Error: expect(received).toBe(expected) // Object.is equality",
            "FAIL: test_login (apps.authn.tests.test_views.LoginTests)",
            "src/api/apps/core/models.py:1:1: F401 [*] `os` imported but unused",
            "Error: connect ECONNREFUSED 127.0.0.1:4100",
            "Too Many Requests: /authn/email-auth/request-code/",
            "botocore.errorfactory.TooManyRequestsException: An error occurred",
            "curl: (22) The requested URL returned error: 404",
            "##[error]Process completed with exit code 1.",
        ):
            with self.subTest(line=line):
                self.assertEqual(transient_errors(STAMP + line), [])


class RetryDecisionTests(TestCase):
    RUN = {"id": 7, "run_attempt": 1, "head_branch": "main", "head_sha": "a" * 40}

    def decide(self, run=None, *, newest_run_id=7, branch_tip="a" * 40, failures=None):
        return retry_decision(
            run or self.RUN,
            newest_run_id=newest_run_id,
            branch_tip=branch_tip,
            failures={"E2E (webkit)": ["registry rate limit"]} if failures is None else failures,
        )

    def test_latest_first_attempt_with_an_infrastructure_error_is_retried(self):
        retry, reason = self.decide()
        self.assertTrue(retry)
        self.assertIn("E2E (webkit)", reason)

    def test_a_code_failure_alongside_does_not_prevent_the_retry(self):
        retry, _ = self.decide(failures={"E2E (webkit)": ["registry rate limit"], "CI Result": []})
        self.assertTrue(retry)

    def test_failures_without_an_infrastructure_error_are_left_alone(self):
        retry, reason = self.decide(failures={"Backend Lint and Format": [], "CI Result": []})
        self.assertFalse(retry)
        self.assertIn("no failed job", reason)

    def test_only_the_first_attempt_is_retried(self):
        retry, _ = self.decide({**self.RUN, "run_attempt": 2})
        self.assertFalse(retry)

    def test_a_superseded_run_is_left_alone(self):
        retry, reason = self.decide(newest_run_id=8)
        self.assertFalse(retry)
        self.assertIn("run 8", reason)

    def test_an_older_run_listed_first_does_not_count_as_newer(self):
        retry, _ = self.decide(newest_run_id=3)
        self.assertTrue(retry)

    def test_a_push_whose_branch_moved_on_is_left_alone(self):
        retry, reason = self.decide(branch_tip="b" * 40)
        self.assertFalse(retry)
        self.assertIn("bbbbbbb", reason)

    def test_pull_request_runs_have_no_branch_tip_to_compare(self):
        retry, _ = self.decide(branch_tip=None)
        self.assertTrue(retry)

    def test_summary_lists_every_failed_job(self):
        summary = render_summary(
            True, "why", {"E2E (webkit)": ["registry rate limit"], "CI Result": []}
        )
        self.assertIn("**Rerunning the failed jobs**: why.", summary)
        self.assertIn("| E2E (webkit) | registry rate limit |", summary)
        self.assertIn("| CI Result | none |", summary)


class RetryWorkflowTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = RETRY_WORKFLOW_PATH.read_text(encoding="utf-8")

    def test_retries_only_a_failed_first_attempt_of_ci(self):
        self.assertRegex(
            self.source, r"workflow_run:\s*\n\s*workflows:\s*\[CI\]\s*\n\s*types:\s*\[completed\]"
        )
        self.assertIn("github.event.workflow_run.conclusion == 'failure'", self.source)
        self.assertIn("github.event.workflow_run.run_attempt == 1", self.source)
        self.assertIn("scripts/ci/retry_transient_failures.py", self.source)

    def test_runs_the_default_branch_script_without_interpolating_run_data(self):
        # Checking out the CI run's commit would let a pull request rewrite the
        # script that holds actions: write.
        self.assertNotIn("ref:", self.source)
        self.assertNotIn("head_sha", self.source)
        for line in re.findall(r"(?m)^\s*run: .*$", self.source):
            with self.subTest(line=line):
                self.assertNotIn("${{", line)


class CIPostgresTests(TestCase):
    def test_postgres_comes_from_the_runner_image_not_a_registry(self):
        source = CI_WORKFLOW_PATH.read_text(encoding="utf-8")
        self.assertNotIn("services:", source)
        self.assertNotIn("public.ecr.aws", source)
        self.assertEqual(source.count("uses: ./.github/actions/setup-postgres"), 3)
