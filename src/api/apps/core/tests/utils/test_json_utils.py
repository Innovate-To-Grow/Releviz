"""Tests for core.utils.json_helpers — safe JSON embedding in HTML script contexts."""

import json

from django.test import TestCase

from apps.core.utils.json_helpers import safe_json


class SafeJsonTests(TestCase):
    def test_escapes_script_close_tag(self):
        result = safe_json("</script>")
        self.assertNotIn("</", result)
        self.assertIn("\\u003C", result)

    def test_escapes_angle_brackets(self):
        result = safe_json("<img src=x onerror=alert(1)>")
        self.assertNotIn("<", result)
        self.assertNotIn(">", result)

    def test_escapes_ampersand(self):
        result = safe_json("a&b")
        self.assertNotIn("&", result)
        self.assertIn("\\u0026", result)

    def test_escapes_line_separators(self):
        result = safe_json("a b c")
        self.assertNotIn(" ", result)
        self.assertNotIn(" ", result)

    def test_output_is_valid_json(self):
        value = {"html": "</script><b>test&foo</b>"}
        result = safe_json(value)
        parsed = json.loads(result)
        self.assertEqual(parsed, value)

    def test_passes_kwargs_to_json_dumps(self):
        result = safe_json({"b": 1, "a": 2}, sort_keys=True)
        parsed = json.loads(result)
        self.assertEqual(list(parsed.keys()), ["a", "b"])
