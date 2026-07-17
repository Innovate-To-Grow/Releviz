from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from scripts.ci.plan_django_tests import APPS, select_apps
from scripts.ci.plan_e2e_tests import ALL_PROJECTS, read_changed_files, select_matrix


class DjangoPlannerTests(TestCase):
    def test_push_runs_every_app(self):
        self.assertEqual(
            select_apps("push", ["backend/src/apps/core/views.py"]), list(APPS)
        )

    def test_shared_backend_change_runs_every_app(self):
        self.assertEqual(
            select_apps("pull_request", ["backend/src/config/urls.py"]), list(APPS)
        )

    def test_scheduling_change_is_focused(self):
        self.assertEqual(
            select_apps("pull_request", ["backend/src/apps/scheduling/views.py"]),
            ["scheduling"],
        )

    def test_auth_change_includes_dependent_apps(self):
        self.assertEqual(
            select_apps("pull_request", ["backend/src/apps/authn/models.py"]),
            ["authn", "messaging", "scheduling"],
        )


class E2EPlannerTests(TestCase):
    def test_push_runs_all_browsers(self):
        matrix = select_matrix("push", ["frontend/app/page.js"])
        self.assertEqual([item["project"] for item in matrix], list(ALL_PROJECTS))

    def test_normal_pr_uses_chromium(self):
        self.assertEqual(
            select_matrix("pull_request", ["frontend/app/page.js"]),
            [{"project": "chromium", "spec_args": ""}],
        )

    def test_accessibility_pr_uses_all_browsers_and_selected_spec(self):
        matrix = select_matrix("pull_request", ["e2e/accessibility.spec.js"])
        self.assertEqual([item["project"] for item in matrix], list(ALL_PROJECTS))
        self.assertTrue(
            all(item["spec_args"] == "e2e/accessibility.spec.js" for item in matrix)
        )

    def test_missing_changed_file_is_empty(self):
        with TemporaryDirectory() as directory:
            self.assertEqual(read_changed_files(Path(directory) / "missing.txt"), [])
