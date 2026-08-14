import copy
import importlib.util
import json
from pathlib import Path

from django.test import SimpleTestCase

REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
TASK_DEFINITION_PATH = REPOSITORY_ROOT / "aws" / "task-definition.json"
VALIDATOR_PATH = REPOSITORY_ROOT / "aws" / "validate_backend_task_definition.py"
WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "deploy-backend.yml"

spec = importlib.util.spec_from_file_location("validate_backend_task_definition", VALIDATOR_PATH)
validator = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(validator)


class ECSTaskDefinitionTopologyTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.taskdef = json.loads(TASK_DEFINITION_PATH.read_text(encoding="utf-8"))

    def test_checked_in_template_has_safe_worker_topology(self):
        validator.validate_task_definition(self.taskdef, rendered=False)

    def test_validator_rejects_worker_running_the_web_entrypoint(self):
        taskdef = copy.deepcopy(self.taskdef)
        worker = next(
            container
            for container in taskdef["containerDefinitions"]
            if container["name"] == validator.WORKER_CONTAINER
        )
        worker.pop("entryPoint")

        with self.assertRaisesRegex(
            validator.TaskDefinitionValidationError,
            "override the image's Web/migration entrypoint",
        ):
            validator.validate_task_definition(taskdef, rendered=False)

    def test_validator_rejects_a_worker_port(self):
        taskdef = copy.deepcopy(self.taskdef)
        worker = next(
            container
            for container in taskdef["containerDefinitions"]
            if container["name"] == validator.WORKER_CONTAINER
        )
        worker["portMappings"] = [{"containerPort": 8001, "protocol": "tcp"}]

        with self.assertRaisesRegex(
            validator.TaskDefinitionValidationError,
            "must not expose a network port",
        ):
            validator.validate_task_definition(taskdef, rendered=False)

    def test_validator_rejects_a_non_deployment_revision_in_the_template(self):
        taskdef = copy.deepcopy(self.taskdef)
        web = next(
            container
            for container in taskdef["containerDefinitions"]
            if container["name"] == validator.WEB_CONTAINER
        )
        revision = next(
            item for item in web["environment"] if item["name"] == "AMPLIFY_CONFIG_REVISION"
        )
        revision["value"] = "latest"

        with self.assertRaisesRegex(
            validator.TaskDefinitionValidationError,
            "must retain its deployment placeholder",
        ):
            validator.validate_task_definition(taskdef, rendered=False)

    def test_backend_workflow_renders_and_validates_the_worker(self):
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

        self.assertIn('containers["itg-background-worker"]', workflow)
        self.assertIn(
            'worker_container["environment"] = deepcopy(web_container["environment"])', workflow
        )
        self.assertIn('worker_container["secrets"] = deepcopy(web_container["secrets"])', workflow)
        self.assertIn(
            "AMPLIFY_CONFIG_REVISION: ${{ github.run_id }}.${{ github.run_attempt }}",
            workflow,
        )
        self.assertIn(
            '"__AMPLIFY_CONFIG_REVISION__": env_value("AMPLIFY_CONFIG_REVISION")',
            workflow,
        )
        self.assertIn(
            "python aws/validate_backend_task_definition.py rendered-task-definition.json --rendered",
            workflow,
        )
