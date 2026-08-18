from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
PREPARE_SCENARIO = ROOT / "scripts/perf/prepare_scale_scenario.py"


def load_prepare_scenario():
    spec = importlib.util.spec_from_file_location("prepare_scale_scenario", PREPARE_SCENARIO)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load prepare_scale_scenario.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PrepareScaleScenarioTests(unittest.TestCase):
    def test_access_tokens_are_bound_to_durable_sessions(self):
        module = load_prepare_scenario()
        member = object()
        issue_session_refresh_token = Mock(
            return_value=SimpleNamespace(access_token="session-bound-access-token")
        )
        security_module = ModuleType("apps.authn.services.security")
        security_module.issue_session_refresh_token = issue_session_refresh_token

        with patch.dict(
            sys.modules,
            {"apps.authn.services.security": security_module},
        ):
            token = module.access_token_for(member)

        self.assertEqual(token, "session-bound-access-token")
        issue_session_refresh_token.assert_called_once_with(member)


class RunE2EScriptTests(unittest.TestCase):
    def test_backend_commands_use_the_repository_environment(self):
        source = (ROOT / "scripts/run-e2e.sh").read_text(encoding="utf-8")

        self.assertIn(
            'python_bin="${PYTHON_BIN:-${repository_root}/src/api/.venv/bin/python}"',
            source,
        )
        self.assertEqual(source.count('"$python_bin" src/api/manage.py'), 2)
        self.assertNotIn("python3 src/api/manage.py", source)

        wait_source = (ROOT / "scripts/db/wait-for-postgres.sh").read_text(encoding="utf-8")
        self.assertIn(
            'python_bin="${PYTHON_BIN:-${repository_root}/src/api/.venv/bin/python}"',
            wait_source,
        )
        self.assertEqual(wait_source.count("\"$python_bin\" - <<'PY'"), 2)
        self.assertNotIn("python3 - <<PY", wait_source)


if __name__ == "__main__":
    unittest.main()
