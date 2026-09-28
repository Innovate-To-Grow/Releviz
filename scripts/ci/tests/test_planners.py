import json
import subprocess
import sys
from pathlib import Path
from unittest import TestCase

from scripts.ci.plan_django_tests import APPS, select_apps
from scripts.ci.plan_e2e_tests import ALL_PROJECTS, SHARDS, select_matrix

ROOT = Path(__file__).resolve().parents[3]


def run_planner(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts/ci" / script), *args],
        capture_output=True,
        check=False,
        cwd=ROOT,
        text=True,
    )


class DjangoPlannerTests(TestCase):
    def test_every_app_is_selected(self):
        self.assertEqual(select_apps(), list(APPS))

    def test_full_flag_prints_every_app_for_the_workflow(self):
        result = run_planner("plan_django_tests.py", "--full")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'apps=["authn","core","mail","scheduling"]\n')

    def test_focused_arguments_are_rejected(self):
        result = run_planner(
            "plan_django_tests.py", "--event-name", "pull_request", "--changed-files", "changed.txt"
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("unrecognized arguments", result.stderr)


class E2EPlannerTests(TestCase):
    def test_every_browser_runs_every_spec_across_its_shards(self):
        matrix = select_matrix()
        self.assertEqual(
            [(item["project"], item["shard"], item["shard_index"]) for item in matrix],
            [
                (project, f"{index}/{SHARDS}", index)
                for project in ALL_PROJECTS
                for index in range(1, SHARDS + 1)
            ],
        )
        self.assertTrue(all(item["spec_args"] == "" for item in matrix))

    def test_full_flag_prints_the_matrix_and_projects_for_the_workflow(self):
        result = run_planner("plan_e2e_tests.py", "--full")
        self.assertEqual(result.returncode, 0, result.stderr)
        matrix_line, projects_line = result.stdout.splitlines()
        self.assertEqual(
            json.loads(matrix_line.removeprefix("matrix=")),
            select_matrix(),
        )
        self.assertEqual(json.loads(projects_line.removeprefix("projects=")), list(ALL_PROJECTS))

    def test_focused_arguments_are_rejected(self):
        result = run_planner(
            "plan_e2e_tests.py", "--event-name", "pull_request", "--changed-files", "changed.txt"
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("unrecognized arguments", result.stderr)
