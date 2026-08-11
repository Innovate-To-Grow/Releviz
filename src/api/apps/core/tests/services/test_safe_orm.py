"""Core-owned tests for the promoted shared safe-ORM layer (the model-access
denylist, write validation, serialization, snapshot, and cascade primitives)."""

import uuid
from unittest.mock import patch

from django.contrib.admin.models import LogEntry
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied
from django.test import TestCase

from apps.cms.models import CMSAsset, CMSBlock
from apps.core.services.db_tools.safe_orm import (
    ActionRequestError,
    assert_snapshot_unchanged,
    assign_model_fields,
    cascade_summary,
    check_model_permission,
    clone_model_instance,
    coerce_field_value,
    collect_cascade_impact,
    field_output_name,
    field_schema,
    get_object,
    is_field_denied,
    is_model_denied,
    json_safe,
    record_repr,
    resolve_model,
    safe_model_fields,
    serialize_model_instance,
    validate_query_key,
    validate_selected_fields,
    validate_write_payload,
)
from apps.event.tests.helpers import make_admin, make_member, make_superuser
from apps.mail.models import LoginLinkToken
from apps.projects.models import Project, Semester

Member = get_user_model()


class SafetyTests(TestCase):
    def safe_names(self):
        return {field_output_name(f) for f in safe_model_fields(Semester, write=False)}

    def test_resolve_model_ok(self):
        self.assertIs(resolve_model("projects", "semester", write=True), Semester)

    def test_resolve_model_unknown_raises(self):
        with self.assertRaises(ActionRequestError):
            resolve_model("projects", "doesnotexist", write=False)

    def test_resolve_model_denied_read(self):
        with self.assertRaises(ActionRequestError):
            resolve_model("admin", "logentry", write=False)

    def test_resolve_model_denied_write(self):
        with self.assertRaises(ActionRequestError):
            resolve_model("admin", "logentry", write=True)

    def test_is_model_denied_variants(self):
        self.assertTrue(is_model_denied(LogEntry, write=False))  # denied app
        self.assertTrue(is_model_denied(Group, write=False))  # denied label
        self.assertTrue(is_model_denied(LoginLinkToken, write=False))  # denied name part "token"
        self.assertFalse(is_model_denied(Semester, write=False))

    def test_safe_model_fields_excludes_filefield(self):
        names = {field_output_name(f) for f in safe_model_fields(CMSAsset, write=False)}
        self.assertNotIn("file", names)

    def test_is_field_denied_branches(self):
        self.assertTrue(is_field_denied(Member._meta.get_field("is_staff"), write=True))  # denied name
        self.assertTrue(is_field_denied(Member._meta.get_field("password"), write=True))  # sensitive regex
        self.assertTrue(is_field_denied(Semester._meta.get_field("id"), write=True))  # pk on write
        self.assertTrue(is_field_denied(Semester._meta.get_field("updated_at"), write=True))  # auto_now
        self.assertFalse(is_field_denied(Semester._meta.get_field("year"), write=True))

    def test_is_field_denied_auto_now_guard_is_independent_of_editable(self):
        # Defense-in-depth: the auto_now guard rejects an auto-timestamp field on
        # write even if it were (artificially) editable, independent of the
        # earlier non-editable guard.
        from django.db import models

        field = models.DateTimeField(auto_now=True)
        field.set_attributes_from_name("touched")
        field.editable = True
        self.assertTrue(is_field_denied(field, write=True))

    def test_field_output_name(self):
        self.assertEqual(field_output_name(Project._meta.get_field("semester")), "semester_id")
        self.assertEqual(field_output_name(Semester._meta.get_field("year")), "year")

    def test_field_schema_includes_choices(self):
        schema = field_schema(Semester._meta.get_field("season"))
        self.assertEqual(schema["name"], "season")
        self.assertTrue(schema["choices"])

    def test_validate_selected_fields(self):
        with self.assertRaises(ActionRequestError):
            validate_selected_fields("year", self.safe_names())
        with self.assertRaises(ActionRequestError):
            validate_selected_fields(["bogus"], self.safe_names())
        self.assertEqual(validate_selected_fields(["year"], self.safe_names()), ["year"])

    def test_validate_query_key(self):
        names = self.safe_names()
        with self.assertRaises(ActionRequestError):
            validate_query_key(5, names)
        with self.assertRaises(ActionRequestError):
            validate_query_key("bogus", names)
        with self.assertRaises(ActionRequestError):
            validate_query_key("year__boguslookup", names)
        validate_query_key("year", names)
        validate_query_key("year__gte", names)
        validate_query_key("-year", names)

    def test_validate_write_payload(self):
        with self.assertRaises(ActionRequestError):
            validate_write_payload(Semester, {"id": "x"})
        self.assertEqual(validate_write_payload(Semester, {"year": 2030}), {"year": 2030})

    def test_assign_model_fields(self):
        obj = Semester()
        assign_model_fields(obj, {"year": 2030, "season": 1})
        self.assertEqual(obj.year, 2030)

    def test_coerce_field_value_branches(self):
        year = Semester._meta.get_field("year")
        self.assertIsNone(coerce_field_value(year, None))
        self.assertEqual(coerce_field_value(CMSBlock._meta.get_field("data"), {"a": 1}), {"a": 1})
        pk = uuid.uuid4()
        self.assertEqual(coerce_field_value(Project._meta.get_field("semester"), str(pk)), pk)
        self.assertEqual(coerce_field_value(year, "2030"), 2030)


class RecordsTests(TestCase):
    def setUp(self):
        self.sem = Semester.objects.create(year=2030, season=1)

    def test_get_object_ok(self):
        self.assertEqual(get_object(Semester, str(self.sem.pk)), self.sem)

    def test_get_object_missing_raises(self):
        with self.assertRaises(ActionRequestError):
            get_object(Semester, str(uuid.uuid4()))

    def test_get_object_bad_pk_raises(self):
        with self.assertRaises(ActionRequestError):
            get_object(Semester, "not-a-uuid")

    def test_serialize_model_instance(self):
        data = serialize_model_instance(self.sem, write=False)
        self.assertIn("__repr__", data)
        self.assertIn("year", data)

    def test_record_repr_truncates(self):
        class Long:
            def __str__(self):
                return "x" * 400

        self.assertEqual(len(record_repr(Long())), 300)
        self.assertEqual(record_repr(self.sem), str(self.sem))

    def test_clone_model_instance(self):
        clone = clone_model_instance(self.sem)
        self.assertEqual(clone.pk, self.sem.pk)
        self.assertFalse(clone._state.adding)

    def test_check_model_permission(self):
        # Non-staff and staff-without-the-app are denied; superuser and staff granted
        # the model's app ("projects") are allowed. See apps.core.utils.access.user_can_access_app.
        with self.assertRaises(PermissionDenied):
            check_model_permission(make_member(email="np@example.com"), Semester, "change")
        with self.assertRaises(PermissionDenied):
            check_model_permission(make_member(email="staff@example.com", is_staff=True), Semester, "change")
        with self.assertRaises(PermissionDenied):
            check_model_permission(make_admin(apps=["cms"], email="cms@example.com"), Semester, "change")
        check_model_permission(make_admin(apps=["projects"], email="pa@example.com"), Semester, "change")
        check_model_permission(make_superuser(email="su@example.com"), Semester, "change")

    def test_assert_snapshot_unchanged(self):
        assert_snapshot_unchanged(None, {"a": 1}, "L")
        assert_snapshot_unchanged({"a": 1}, {"a": 1}, "L")
        with self.assertRaises(ActionRequestError):
            assert_snapshot_unchanged({"a": 1}, {"a": 2}, "L")


class CascadeTests(TestCase):
    def setUp(self):
        self.sem = Semester.objects.create(year=2030, season=1)

    def test_zero_cascade(self):
        self.assertEqual(collect_cascade_impact(self.sem)["total"], 0)

    def test_cascade_with_children(self):
        Project.objects.create(semester=self.sem, project_title="Child")
        result = collect_cascade_impact(self.sem)
        self.assertGreaterEqual(result["total"], 1)
        self.assertTrue(any(item["model"] == "projects.Project" for item in result["related"]))

    def test_cascade_counts_sibling_rows_of_same_class(self):
        sib1 = Semester.objects.create(year=2031, season=1)
        sib2 = Semester.objects.create(year=2032, season=1)

        def fake_collect(collector, objs, *args, **kwargs):
            collector.data = {Semester: {self.sem, sib1, sib2}}

        with patch(
            "apps.core.services.db_tools.safe_orm.cascade.Collector.collect",
            autospec=True,
            side_effect=fake_collect,
        ):
            result = collect_cascade_impact(self.sem)
        self.assertEqual(result["total"], 2)  # the target itself is excluded

    def test_cascade_handles_collector_failure(self):
        with patch(
            "apps.core.services.db_tools.safe_orm.cascade.Collector.collect",
            side_effect=RuntimeError("boom"),
        ):
            result = collect_cascade_impact(self.sem)
        self.assertEqual(result["total"], 0)
        self.assertIn("error", result)

    def test_cascade_summary(self):
        self.assertEqual(cascade_summary("base", {"total": 0}), "base")
        with_total = cascade_summary("base", {"total": 2, "related": [{"model": "X", "count": 2}]})
        self.assertIn("Cascade will also remove", with_total)
        many = cascade_summary(
            None,
            {"total": 9, "related": [{"model": m, "count": 1} for m in ("A", "B", "C", "D")]},
        )
        self.assertIn("...", many)


class JsonTests(TestCase):
    def test_json_safe_roundtrips_uuid(self):
        value = json_safe({"id": uuid.uuid4()})
        self.assertIsInstance(value["id"], str)
