from pathlib import Path

from django.test import SimpleTestCase

SERVICE_ROOT = Path(__file__).resolve().parents[2] / "services"
MAX_PYTHON_FILE_LINES = 200
MAX_DIRECT_PYTHON_FILES = 10


class CoreServicesStructureTests(SimpleTestCase):
    def test_python_files_are_under_line_limit(self):
        offenders = []
        for path in sorted(SERVICE_ROOT.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            line_count = sum(1 for _ in path.open(encoding="utf-8"))
            if line_count > MAX_PYTHON_FILE_LINES:
                offenders.append(f"{path.relative_to(SERVICE_ROOT)}: {line_count}")

        self.assertEqual([], offenders)

    def test_directories_have_limited_python_files(self):
        directories = [SERVICE_ROOT]
        directories.extend(path for path in SERVICE_ROOT.rglob("*") if path.is_dir())

        offenders = []
        for directory in sorted(directories):
            if "__pycache__" in directory.parts:
                continue
            python_files = sorted(path.name for path in directory.iterdir() if path.is_file() and path.suffix == ".py")
            if len(python_files) > MAX_DIRECT_PYTHON_FILES:
                relative = directory.relative_to(SERVICE_ROOT)
                offenders.append(f"{relative}: {len(python_files)} files ({', '.join(python_files)})")

        self.assertEqual([], offenders)
