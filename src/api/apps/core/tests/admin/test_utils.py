"""Tests for core.admin.utils helper functions."""

from django.test import TestCase

from apps.core.admin.common.utils import (
    admin_url,
    format_duration,
    format_file_size,
    format_json,
    get_field_value,
    truncate_text,
)


class AdminUrlTest(TestCase):
    def test_none_returns_dash(self):
        self.assertEqual(admin_url(None), "-")

    def test_generates_link_with_default_label(self):
        from apps.projects.models import Semester

        semester = Semester.objects.create(year=2025, season=1, is_published=True)
        html = admin_url(semester)
        self.assertIn(f"/admin/projects/semester/{semester.pk}/change/", html)
        self.assertIn(str(semester), html)
        self.assertIn("<a href=", html)

    def test_custom_label(self):
        from apps.projects.models import Semester

        semester = Semester.objects.create(year=2025, season=1, is_published=True)
        html = admin_url(semester, label="Click me")
        self.assertIn("Click me", html)


class TruncateTextTest(TestCase):
    def test_short_text_unchanged(self):
        self.assertEqual(truncate_text("hello", 50), "hello")

    def test_long_text_truncated(self):
        result = truncate_text("a" * 100, 10)
        self.assertLessEqual(len(result), 13)  # 10 chars + "..."
        self.assertTrue(result.endswith("..."))

    def test_empty_returns_dash(self):
        self.assertEqual(truncate_text(""), "-")

    def test_none_returns_dash(self):
        self.assertEqual(truncate_text(None), "-")


class FormatJsonTest(TestCase):
    def test_dict_formatted(self):
        result = format_json({"a": 1})
        # format_html escapes quotes to &quot;
        self.assertIn("&quot;a&quot;: 1", result)
        self.assertIn("<pre", result)

    def test_json_string_parsed(self):
        result = format_json('{"key": "value"}')
        self.assertIn("&quot;key&quot;", result)

    def test_none_returns_dash(self):
        self.assertEqual(format_json(None), "-")

    def test_invalid_json_string_shows_raw(self):
        result = format_json("not-json{")
        self.assertIn("not-json{", result)


class GetFieldValueTest(TestCase):
    def test_simple_attribute(self):
        class Obj:
            name = "test"

        self.assertEqual(get_field_value(Obj(), "name"), "test")

    def test_nested_attribute(self):
        class Inner:
            value = 42

        class Outer:
            inner = Inner()

        self.assertEqual(get_field_value(Outer(), "inner__value"), 42)

    def test_none_object_returns_none(self):
        self.assertIsNone(get_field_value(None, "name"))

    def test_missing_attribute_returns_none(self):
        class Obj:
            pass

        self.assertIsNone(get_field_value(Obj(), "nonexistent"))

    def test_broken_chain_returns_none(self):
        class Obj:
            middle = None

        self.assertIsNone(get_field_value(Obj(), "middle__deep"))


class FormatFileSizeTest(TestCase):
    def test_bytes(self):
        self.assertEqual(format_file_size(512), "512.0 B")

    def test_kilobytes(self):
        self.assertEqual(format_file_size(1024), "1.0 KB")

    def test_megabytes(self):
        self.assertEqual(format_file_size(1024 * 1024), "1.0 MB")

    def test_gigabytes(self):
        self.assertEqual(format_file_size(1024**3), "1.0 GB")

    def test_none_returns_dash(self):
        self.assertEqual(format_file_size(None), "-")

    def test_zero(self):
        self.assertEqual(format_file_size(0), "0.0 B")

    def test_petabytes(self):
        # Larger than 1024 TB falls through the unit loop to the PB branch.
        self.assertEqual(format_file_size(1024**5), "1.0 PB")


class FormatDurationTest(TestCase):
    def test_seconds_only(self):
        self.assertEqual(format_duration(45), "45s")

    def test_minutes_and_seconds(self):
        self.assertEqual(format_duration(125), "2m 5s")

    def test_exact_minutes(self):
        self.assertEqual(format_duration(120), "2m")

    def test_hours_and_minutes(self):
        self.assertEqual(format_duration(3600 + 900), "1h 15m")

    def test_days(self):
        self.assertEqual(format_duration(86400 + 7200 + 1800), "1d 2h 30m")

    def test_none_returns_dash(self):
        self.assertEqual(format_duration(None), "-")

    def test_zero(self):
        self.assertEqual(format_duration(0), "0s")
