"""Coverage for the migration-compat export upload-path shim."""

from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.core.models.base.system_intelligence.export import _export_upload_to


class ExportUploadToTest(SimpleTestCase):
    def test_builds_namespaced_path(self):
        instance = SimpleNamespace(id="abc-123")
        path = _export_upload_to(instance, "report.csv")
        self.assertEqual(path, "system_intelligence_exports/abc-123/report.csv")
