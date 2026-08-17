"""Tests for confirm_on_save_utils helper functions."""

import uuid
from datetime import date, datetime
from unittest.mock import MagicMock, patch

from django.http import QueryDict
from django.test import TestCase
from django.utils import timezone

import apps.core.admin.mixins.confirm_on_save_utils as logger_module
from apps.core.admin.mixins.confirm_on_save_utils import (
    compute_add_diff,
    compute_change_diff,
    compute_delete_diff,
    deserialize_post_data,
    format_field_value,
    serialize_post_data,
)
from apps.core.models import AWSCredentialConfig


class SerializePostDataTest(TestCase):
    def test_roundtrip_simple_data(self):
        qd = QueryDict(mutable=True)
        qd["name"] = "Hello"
        qd["active"] = "on"

        serialized = serialize_post_data(qd)
        restored = deserialize_post_data(serialized)

        self.assertEqual(restored["name"], "Hello")
        self.assertEqual(restored["active"], "on")

    def test_roundtrip_multi_value_keys(self):
        qd = QueryDict(mutable=True)
        qd.setlist("tags", ["python", "django", "admin"])

        serialized = serialize_post_data(qd)
        restored = deserialize_post_data(serialized)

        self.assertEqual(restored.getlist("tags"), ["python", "django", "admin"])

    def test_empty_querydict(self):
        qd = QueryDict(mutable=True)
        serialized = serialize_post_data(qd)
        restored = deserialize_post_data(serialized)

        self.assertEqual(len(restored), 0)


class FormatFieldValueTest(TestCase):
    def test_none_returns_dash(self):
        self.assertEqual(format_field_value(None), "-")

    def test_bool_true(self):
        self.assertEqual(format_field_value(True), "Yes")

    def test_bool_false(self):
        self.assertEqual(format_field_value(False), "No")

    def test_datetime_formatted(self):
        dt = datetime(2025, 6, 15, 10, 30, 0)
        result = format_field_value(dt)
        self.assertIn("2025-06-15", result)
        self.assertIn("10:30:00", result)

    def test_aware_datetime_includes_timezone(self):
        dt = timezone.now()
        result = format_field_value(dt)
        self.assertIn("UTC", result)

    def test_date_formatted(self):
        d = date(2025, 3, 15)
        self.assertEqual(format_field_value(d), "2025-03-15")

    def test_uuid_as_string(self):
        u = uuid.uuid4()
        self.assertEqual(format_field_value(u), str(u))

    def test_model_instance_uses_str(self):
        obj = MagicMock()
        obj.__str__ = MagicMock(return_value="Mock Object Name")
        self.assertEqual(format_field_value(obj), "Mock Object Name")

    def test_list_serialized_as_json(self):
        result = format_field_value([1, 2, 3])
        self.assertEqual(result, "[1, 2, 3]")

    def test_dict_serialized_as_json(self):
        result = format_field_value({"key": "value"})
        self.assertIn('"key"', result)
        self.assertIn('"value"', result)

    def test_long_string_truncated(self):
        long_str = "x" * 300
        result = format_field_value(long_str)
        self.assertEqual(len(result), 203)  # 200 + "..."
        self.assertTrue(result.endswith("..."))

    def test_short_string_not_truncated(self):
        self.assertEqual(format_field_value("short"), "short")

    def test_integer(self):
        self.assertEqual(format_field_value(42), "42")


class ComputeAddDiffTest(TestCase):
    def test_returns_all_fields_with_values(self):
        form = MagicMock()
        form.fields = {"name": MagicMock(label="Name"), "active": MagicMock(label="Active")}
        form.cleaned_data = {"name": "Test", "active": True}

        diff = compute_add_diff(form)

        self.assertEqual(len(diff), 2)
        self.assertEqual(diff[0]["field"], "name")
        self.assertEqual(diff[0]["new_value"], "Test")
        self.assertEqual(diff[1]["field"], "active")
        self.assertEqual(diff[1]["new_value"], "Yes")

    def test_skips_fields_not_in_cleaned_data(self):
        form = MagicMock()
        form.fields = {"name": MagicMock(label="Name"), "hidden": MagicMock(label="Hidden")}
        form.cleaned_data = {"name": "Test"}

        diff = compute_add_diff(form)

        self.assertEqual(len(diff), 1)
        self.assertEqual(diff[0]["field"], "name")

    def test_uses_field_name_when_label_is_none(self):
        form = MagicMock()
        form.fields = {"slug": MagicMock(label=None)}
        form.cleaned_data = {"slug": "my-slug"}

        diff = compute_add_diff(form)

        self.assertEqual(diff[0]["label"], "slug")


class ComputeChangeDiffTest(TestCase):
    def test_returns_changed_fields_only(self):
        obj = AWSCredentialConfig.objects.create(name="Old", is_active=True)

        form = MagicMock()
        form.changed_data = ["name"]
        form.fields = {"name": MagicMock(label="Name")}
        form.cleaned_data = {"name": "New"}

        diff = compute_change_diff(AWSCredentialConfig, obj.pk, form)

        self.assertEqual(len(diff), 1)
        self.assertEqual(diff[0]["old_value"], "Old")
        self.assertEqual(diff[0]["new_value"], "New")

    def test_empty_changed_data_returns_empty(self):
        form = MagicMock()
        form.changed_data = []

        diff = compute_change_diff(AWSCredentialConfig, "fake-id", form)

        self.assertEqual(diff, [])

    def test_nonexistent_object_returns_empty(self):
        form = MagicMock()
        form.changed_data = ["name"]
        form.fields = {"name": MagicMock(label="Name")}
        form.cleaned_data = {"name": "New"}

        diff = compute_change_diff(AWSCredentialConfig, 999999, form)

        self.assertEqual(diff, [])


class ComputeDeleteDiffTest(TestCase):
    def test_returns_field_values_for_object(self):
        obj = AWSCredentialConfig.objects.create(name="Delete me", is_active=True)

        diff = compute_delete_diff(obj)

        field_names = [d["field"] for d in diff]
        self.assertIn("name", field_names)
        self.assertIn("is_active", field_names)

        name_entry = next(d for d in diff if d["field"] == "name")
        self.assertEqual(name_entry["value"], "Delete me")

    def test_excludes_id_field(self):
        obj = AWSCredentialConfig.objects.create(name="No id", is_active=True)

        diff = compute_delete_diff(obj)

        field_names = [d["field"] for d in diff]
        self.assertNotIn("id", field_names)

    def test_skips_reverse_relations_without_column(self):
        """Reverse relations (no `column` attr) are skipped in the delete diff."""
        from apps.core.tests.helpers import make_member

        member = make_member(email="reverse@example.com")
        diff = compute_delete_diff(member)
        field_names = [d["field"] for d in diff]
        # Concrete columns appear...
        self.assertIn("first_name", field_names)
        # ...but the reverse contact relation (no column) is skipped.
        self.assertNotIn("contact_emails", field_names)

    def test_skips_fields_that_raise(self):
        """A field whose value access raises is skipped (logged at debug)."""

        class _BoomField:
            name = "explodes"
            column = "explodes"
            verbose_name = "Explodes"

        class _OkField:
            name = "ok_field"
            column = "ok_field"
            verbose_name = "Ok Field"

        class _Meta:
            @staticmethod
            def get_fields():
                return [_BoomField(), _OkField()]

        class _FakeObj:
            _meta = _Meta()

            def __getattribute__(self, item):
                if item == "explodes":
                    raise RuntimeError("cannot read")
                return super().__getattribute__(item)

            ok_field = "fine"

        with patch.object(logger_module.logger, "debug") as debug_log:
            diff = compute_delete_diff(_FakeObj())

        field_names = [d["field"] for d in diff]
        self.assertNotIn("explodes", field_names)
        self.assertIn("ok_field", field_names)
        debug_log.assert_called_once()


class ComputeChangeDiffExtraTest(TestCase):
    def test_skips_changed_field_not_in_form_fields(self):
        obj = AWSCredentialConfig.objects.create(name="X", is_active=True)
        form = MagicMock()
        form.changed_data = ["name", "phantom"]
        form.fields = {"name": MagicMock(label="Name")}
        form.cleaned_data = {"name": "Y", "phantom": "z"}

        diff = compute_change_diff(AWSCredentialConfig, obj.pk, form)
        fields = [d["field"] for d in diff]
        self.assertIn("name", fields)
        self.assertNotIn("phantom", fields)

    def test_get_field_exception_falls_back_to_getattr(self):
        obj = AWSCredentialConfig.objects.create(name="X", is_active=True)
        form = MagicMock()
        form.changed_data = ["is_active"]
        form.fields = {"is_active": MagicMock(label="Active")}
        form.cleaned_data = {"is_active": False}

        real_get_field = AWSCredentialConfig._meta.get_field

        def selective(name, *args, **kwargs):
            # Only blow up for the diff lookup of "is_active"; let the ORM's
            # internal get_field calls (used by objects.get) work normally.
            if name == "is_active":
                raise Exception("no field")
            return real_get_field(name, *args, **kwargs)

        with patch.object(AWSCredentialConfig._meta, "get_field", side_effect=selective):
            diff = compute_change_diff(AWSCredentialConfig, obj.pk, form)
        self.assertEqual(diff[0]["old_value"], "Yes")  # original is_active=True

    def test_foreign_key_old_value(self):
        """A changed FK field resolves the related object via getattr."""
        from apps.core.tests.helpers import make_member
        from apps.scheduling.models import Event, Participant

        member = make_member(email="fk@example.com")
        event = Event.objects.create(code="FK1", name="E", organizer=member)
        participant = Participant.objects.create(
            event=event,
            member=member,
            participant_name="Door",
        )
        form = MagicMock()
        form.changed_data = ["event"]
        form.fields = {"event": MagicMock(label="Event")}
        new_event = Event.objects.create(code="FK2", name="E2", organizer=member)
        form.cleaned_data = {"event": new_event}

        diff = compute_change_diff(Participant, participant.pk, form)
        self.assertEqual(diff[0]["old_value"], str(event))


class FormatFieldValueExtraTest(TestCase):
    def test_real_model_instance(self):
        config = AWSCredentialConfig.objects.create(name="Instance", is_active=True)
        self.assertEqual(format_field_value(config), str(config))

    def test_queryset_joined(self):
        AWSCredentialConfig.objects.create(name="First", is_active=False)
        AWSCredentialConfig.objects.create(name="Second", is_active=False)
        result = format_field_value(AWSCredentialConfig.objects.all())
        self.assertIn(",", result)

    def test_unserializable_list_falls_back_to_str(self):
        class Weird:
            def __repr__(self):
                return "WEIRD"

        # json.dumps with default=str usually succeeds; force a TypeError instead.
        with patch("json.dumps", side_effect=TypeError("nope")):
            result = format_field_value([Weird()])
        self.assertIn("WEIRD", result)
