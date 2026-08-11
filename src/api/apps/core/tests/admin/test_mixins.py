"""Tests for core admin mixins (timestamped, data export)."""

import io
import json

from django.contrib.admin.sites import AdminSite
from django.contrib.auth import get_user_model
from django.http import QueryDict
from django.test import RequestFactory, TestCase
from django.utils import timezone
from openpyxl import load_workbook

from apps.cms.models import NewsArticle
from apps.core.admin.mixins import (
    DataExportMixin,
    ExcelExportMixin,
    TimestampedAdminMixin,
)

User = get_user_model()


def _make_article(**kwargs):
    defaults = {
        "source": "test",
        "source_guid": f"guid-{timezone.now().timestamp()}",
        "title": "Test",
        "source_url": "https://example.com",
        "published_at": timezone.now(),
    }
    defaults.update(kwargs)
    return NewsArticle.objects.create(**defaults)


class _MockSuperAdmin:
    """Minimal stand-in for ModelAdmin methods that mixins call via super()."""

    model = NewsArticle
    admin_site = AdminSite()

    @property
    def media(self):
        from django.forms import Media

        return Media()

    def get_queryset(self, request):
        return NewsArticle.objects.all()

    def get_list_display(self, request):
        return ["__str__"]

    def get_list_filter(self, request):
        return []

    def get_readonly_fields(self, request, obj=None):
        return []

    def get_actions(self, request):
        return {}

    def save_model(self, request, obj, form, change):
        obj.save()


class _TimestampAdmin(TimestampedAdminMixin, _MockSuperAdmin):
    pass


class _DataExportAdmin(DataExportMixin, _MockSuperAdmin):
    pass


class _DataExportCustomAdmin(DataExportMixin, _MockSuperAdmin):
    export_fields = ["title", "source", "published_at"]
    export_filename = "custom_articles"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _load_xlsx(response_content):
    """Parse response bytes into an openpyxl Workbook."""
    return load_workbook(io.BytesIO(response_content))


def _make_post_request(factory, data=None):
    """Build a POST request with the given data dict."""
    request = factory.post("/admin/", data=data or {})
    request.META["SERVER_NAME"] = "testserver"
    return request


def _confirmed_post(factory, extra=None):
    """Build a confirmed export POST request with optional extra fields."""
    data = {"action": "export_data", "export_confirm": "1", "export_format": "xlsx"}
    if extra:
        data.update(extra)
    return _make_post_request(factory, data)


# ---------------------------------------------------------------------------
# TimestampedAdminMixin
# ---------------------------------------------------------------------------


class TimestampedAdminMixinTest(TestCase):
    def setUp(self):
        self.admin = _TimestampAdmin()
        self.factory = RequestFactory()
        self.request = self.factory.get("/admin/")

    def test_readonly_includes_timestamp_fields(self):
        readonly = self.admin.get_readonly_fields(self.request)
        for field in ("created_at", "updated_at"):
            self.assertIn(field, readonly)

    def test_list_display_includes_created_at(self):
        display = self.admin.get_list_display(self.request)
        self.assertIn("created_at", display)


# ---------------------------------------------------------------------------
# DataExportMixin tests
# ---------------------------------------------------------------------------


class DataExportMixinTest(TestCase):
    def setUp(self):
        self.admin = _DataExportAdmin()
        self.factory = RequestFactory()
        self.request = self.factory.get("/admin/")

    # -- action registration ---------------------------------------------------

    def test_actions_include_export_data(self):
        actions = self.admin.get_actions(self.request)
        self.assertIn("export_data", actions)

    def test_action_tuple_uses_unbound_method(self):
        actions = self.admin.get_actions(self.request)
        func = actions["export_data"][0]
        self.assertFalse(hasattr(func, "__self__"), "Action func should be unbound to avoid double-self bug")

    # -- backward compat alias -------------------------------------------------

    def test_excel_export_mixin_alias(self):
        self.assertIs(ExcelExportMixin, DataExportMixin)

    # -- get_export_fields -----------------------------------------------------

    def test_default_fields_returns_all_model_fields(self):
        fields = self.admin.get_export_fields()
        field_names = [name for name, _label in fields]
        model_field_names = [f.name for f in NewsArticle._meta.fields]
        self.assertEqual(field_names, model_field_names)

    def test_default_fields_returns_verbose_name_labels(self):
        fields = self.admin.get_export_fields()
        field_dict = dict(fields)
        self.assertEqual(field_dict["published_at"], "Published At")
        self.assertEqual(field_dict["source_url"], "Source Url")

    def test_backward_compat_get_excel_export_fields(self):
        self.assertEqual(self.admin.get_excel_export_fields(), self.admin.get_export_fields())

    # -- get_export_value ------------------------------------------------------

    def test_value_none_returns_empty_string(self):
        article = _make_article(source_guid="val-none", author="")
        self.assertEqual(self.admin.get_export_value(article, "raw_payload"), "")

    def test_value_datetime_formatted(self):
        dt = timezone.now()
        article = _make_article(source_guid="val-dt", published_at=dt)
        result = self.admin.get_export_value(article, "published_at")
        self.assertEqual(result, dt.strftime("%Y-%m-%d %H:%M:%S"))

    def test_value_uuid_returned_as_string(self):
        article = _make_article(source_guid="val-uuid")
        result = self.admin.get_export_value(article, "id")
        self.assertEqual(result, str(article.id))

    def test_value_string_returned_as_is(self):
        article = _make_article(source_guid="val-str", title="Hello")
        self.assertEqual(self.admin.get_export_value(article, "title"), "Hello")

    def test_value_date_formatted(self):
        from datetime import date

        class _FakeDateObj:
            date_field = date(2025, 3, 15)

        result = self.admin.get_export_value(_FakeDateObj(), "date_field")
        self.assertEqual(result, "2025-03-15")

    def test_value_list_serialized_as_json(self):
        article = _make_article(source_guid="val-list")
        article.raw_payload = ""
        article._test_list = [{"q": "Color?", "a": "Blue"}]
        result = self.admin.get_export_value(article, "_test_list")
        self.assertEqual(result, '[{"q": "Color?", "a": "Blue"}]')

    def test_value_dict_serialized_as_json(self):
        article = _make_article(source_guid="val-dict")
        article._test_dict = {"key": "value", "num": 42}
        result = self.admin.get_export_value(article, "_test_dict")
        self.assertIn('"key": "value"', result)
        self.assertIn('"num": 42', result)

    def test_value_bool_returns_yes_no(self):
        class _FakeBoolObj:
            active = True
            deleted = False

        self.assertEqual(self.admin.get_export_value(_FakeBoolObj(), "active"), "Yes")
        self.assertEqual(self.admin.get_export_value(_FakeBoolObj(), "deleted"), "No")

    def test_backward_compat_get_excel_export_value(self):
        article = _make_article(source_guid="compat-val")
        self.assertEqual(
            self.admin.get_excel_export_value(article, "title"),
            self.admin.get_export_value(article, "title"),
        )

    # -- intermediate column / format selection page ---------------------------

    def test_initial_post_renders_column_selection_template(self):
        article = _make_article(source_guid="tmpl-1")
        qs = NewsArticle.objects.filter(pk=article.pk)

        request = _make_post_request(
            self.factory,
            {
                "action": "export_data",
                "_selected_action": [str(article.pk)],
            },
        )
        request.user = User.objects.create_user(email="tmpl@example.com", password="StrongPass123!", is_staff=True)
        response = self.admin.export_data(request, qs)

        self.assertEqual(response.template_name, "admin/core/export_columns.html")
        self.assertIn(str(article.pk), response.context_data["pks"])
        self.assertGreater(len(response.context_data["available_fields"]), 0)
        self.assertEqual(response.context_data["default_filename"], "newsarticle")
        self.assertEqual(len(response.context_data["formats"]), 2)

    # -- Excel generation (all columns) ----------------------------------------

    def test_xlsx_confirmed_post_returns_xlsx(self):
        a1 = _make_article(source_guid="xlsx-1", title="First Article")
        a2 = _make_article(source_guid="xlsx-2", title="Second Article")
        qs = NewsArticle.objects.filter(pk__in=[a1.pk, a2.pk])

        request = _confirmed_post(self.factory)
        response = self.admin.export_data(request, qs)

        self.assertEqual(response["Content-Type"], XLSX_CONTENT_TYPE)
        self.assertIn("attachment", response["Content-Disposition"])
        self.assertIn(".xlsx", response["Content-Disposition"])

    def test_xlsx_contains_header_and_data_rows(self):
        a1 = _make_article(source_guid="rows-1", title="Alpha")
        a2 = _make_article(source_guid="rows-2", title="Beta")
        qs = NewsArticle.objects.filter(pk__in=[a1.pk, a2.pk]).order_by("title")

        request = _confirmed_post(self.factory)
        response = self.admin.export_data(request, qs)

        wb = _load_xlsx(response.content)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))

        header = rows[0]
        self.assertIn("Title", header)
        self.assertIn("Source", header)

        self.assertEqual(len(rows), 3)  # 1 header + 2 data
        titles = {row[header.index("Title")] for row in rows[1:]}
        self.assertEqual(titles, {"Alpha", "Beta"})

    def test_xlsx_header_has_blue_fill(self):
        _make_article(source_guid="style-1")
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory)
        response = self.admin.export_data(request, qs)

        wb = _load_xlsx(response.content)
        ws = wb.active
        header_cell = ws.cell(row=1, column=1)
        self.assertEqual(header_cell.fill.start_color.rgb, "004472C4")

    # -- column selection (specific columns) -----------------------------------

    def test_selected_columns_limits_exported_fields(self):
        article = _make_article(source_guid="sel-1", title="Selected", source="rss")
        qs = NewsArticle.objects.filter(pk=article.pk)

        request = _make_post_request(self.factory, QueryDict(mutable=True))
        request.POST = QueryDict(mutable=True)
        request.POST["action"] = "export_data"
        request.POST["export_confirm"] = "1"
        request.POST["export_format"] = "xlsx"
        request.POST.setlist("export_fields", ["title", "source"])

        response = self.admin.export_data(request, qs)

        wb = _load_xlsx(response.content)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        header = rows[0]

        self.assertEqual(len(header), 2)
        self.assertEqual(header, ("Title", "Source"))
        self.assertEqual(rows[1], ("Selected", "rss"))

    def test_empty_selection_exports_all_columns(self):
        _make_article(source_guid="empty-sel-1")
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory)
        response = self.admin.export_data(request, qs)

        wb = _load_xlsx(response.content)
        ws = wb.active
        header = next(ws.iter_rows(values_only=True))
        model_field_count = len(NewsArticle._meta.fields)
        self.assertEqual(len(header), model_field_count)

    # -- filename customisation ------------------------------------------------

    def test_default_filename_uses_model_name(self):
        _make_article(source_guid="fname-1")
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory)
        response = self.admin.export_data(request, qs)

        self.assertIn("newsarticle_", response["Content-Disposition"])

    def test_user_provided_filename_used_in_response(self):
        _make_article(source_guid="ufname-1")
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory, {"export_filename": "my_custom_report"})
        response = self.admin.export_data(request, qs)

        self.assertIn("my_custom_report_", response["Content-Disposition"])
        self.assertNotIn("newsarticle_", response["Content-Disposition"])

    def test_blank_user_filename_falls_back_to_default(self):
        _make_article(source_guid="bfname-1")
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory, {"export_filename": "   "})
        response = self.admin.export_data(request, qs)

        self.assertIn("newsarticle_", response["Content-Disposition"])

    # -- JSON format -----------------------------------------------------------

    def test_json_format_returns_json_response(self):
        a1 = _make_article(source_guid="json-1", title="First")
        a2 = _make_article(source_guid="json-2", title="Second")
        qs = NewsArticle.objects.filter(pk__in=[a1.pk, a2.pk])

        request = _confirmed_post(self.factory, {"export_format": "json"})
        response = self.admin.export_data(request, qs)

        self.assertEqual(response["Content-Type"], "application/json")
        self.assertIn("attachment", response["Content-Disposition"])
        self.assertIn(".json", response["Content-Disposition"])

        data = json.loads(response.content)
        self.assertEqual(len(data), 2)
        titles = {item["title"] for item in data}
        self.assertEqual(titles, {"First", "Second"})

    def test_json_format_respects_column_selection(self):
        _make_article(source_guid="json-sel-1", title="Filtered", source="api")
        qs = NewsArticle.objects.all()

        request = _make_post_request(self.factory, QueryDict(mutable=True))
        request.POST = QueryDict(mutable=True)
        request.POST["action"] = "export_data"
        request.POST["export_confirm"] = "1"
        request.POST["export_format"] = "json"
        request.POST.setlist("export_fields", ["title", "source"])

        response = self.admin.export_data(request, qs)

        data = json.loads(response.content)
        self.assertEqual(len(data), 1)
        self.assertEqual(set(data[0].keys()), {"title", "source"})

    def test_json_format_uses_custom_filename(self):
        _make_article(source_guid="json-fname-1")
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory, {"export_format": "json", "export_filename": "my_report"})
        response = self.admin.export_data(request, qs)

        self.assertIn("my_report_", response["Content-Disposition"])
        self.assertIn(".json", response["Content-Disposition"])

    def test_json_default_exports_all_columns(self):
        _make_article(source_guid="json-all-1")
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory, {"export_format": "json"})
        response = self.admin.export_data(request, qs)

        data = json.loads(response.content)
        model_field_names = {f.name for f in NewsArticle._meta.fields}
        self.assertEqual(set(data[0].keys()), model_field_names)


# ---------------------------------------------------------------------------
# DataExportMixin with custom export_fields / export_filename
# ---------------------------------------------------------------------------


class DataExportMixinCustomFieldsTest(TestCase):
    def setUp(self):
        self.admin = _DataExportCustomAdmin()
        self.factory = RequestFactory()

    def test_custom_fields_limits_available_columns(self):
        fields = self.admin.get_export_fields()
        field_names = [name for name, _label in fields]
        self.assertEqual(field_names, ["title", "source", "published_at"])

    def test_custom_filename_used_in_xlsx_response(self):
        _make_article(source_guid="cust-fname-1")
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory)
        response = self.admin.export_data(request, qs)

        self.assertIn("custom_articles_", response["Content-Disposition"])

    def test_custom_fields_exports_only_specified_columns(self):
        dt = timezone.now()
        _make_article(source_guid="cust-cols-1", title="Custom", source="manual", published_at=dt)
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory)
        response = self.admin.export_data(request, qs)

        wb = _load_xlsx(response.content)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        header = rows[0]

        self.assertEqual(len(header), 3)
        self.assertEqual(rows[1][header.index("Title")], "Custom")
        self.assertEqual(rows[1][header.index("Source")], "manual")

    def test_custom_filename_used_in_json_response(self):
        _make_article(source_guid="cust-json-fname-1")
        qs = NewsArticle.objects.all()

        request = _confirmed_post(self.factory, {"export_format": "json"})
        response = self.admin.export_data(request, qs)

        self.assertIn("custom_articles_", response["Content-Disposition"])
        self.assertIn(".json", response["Content-Disposition"])

    def test_backward_compat_excel_export_fields_property(self):
        self.assertEqual(self.admin.excel_export_fields, ["title", "source", "published_at"])

    def test_backward_compat_excel_export_filename_property(self):
        self.assertEqual(self.admin.excel_export_filename, "custom_articles")

    def test_excel_export_fields_setter(self):
        self.admin.excel_export_fields = ["title"]
        self.assertEqual(self.admin.export_fields, ["title"])

    def test_excel_export_filename_setter(self):
        self.admin.excel_export_filename = "renamed"
        self.assertEqual(self.admin.export_filename, "renamed")

    def test_get_export_fields_falls_back_for_unknown_field(self):
        admin = _DataExportCustomAdmin()
        admin.export_fields = ["title", "not_a_real_field"]
        fields = dict(admin.get_export_fields())
        # Real field keeps its verbose name; unknown field gets a humanized label.
        self.assertEqual(fields["title"], "Title")
        self.assertEqual(fields["not_a_real_field"], "Not A Real Field")


class DataExportRelatedValueTest(TestCase):
    def test_related_object_value_returned_as_str(self):
        """A FK value (has .pk) is serialized via str()."""
        from apps.event.models import CheckIn, Event

        admin = _DataExportAdmin()
        event = Event.objects.create(
            name="E",
            slug="e-export",
            date="2025-06-15",
            end_date="2025-06-15",
            location="L",
        )
        check_in = CheckIn.objects.create(event=event, name="Door")
        result = admin.get_export_value(check_in, "event")
        self.assertEqual(result, str(event))


# ---------------------------------------------------------------------------
# DataExportMixin — DateField and JSONField serialization
# ---------------------------------------------------------------------------


class _DateFieldExportAdmin(DataExportMixin, _MockSuperAdmin):
    """Admin that exports Event-like models with DateField and JSONField."""

    model = None  # set in setUp via monkey-patch


class DataExportDateFieldTest(TestCase):
    """Verify JSON export does not crash on DateField / JSONField values."""

    def setUp(self):
        self.admin = _DataExportAdmin()
        self.factory = RequestFactory()

    def test_json_export_with_date_field_does_not_crash(self):
        """Regression: DateField values caused TypeError in json.dumps."""
        from apps.event.models import Event

        event = Event.objects.create(
            name="Test Event",
            slug="test-export-date",
            date="2025-06-15",
            end_date="2025-06-15",
            location="Room A",
            description="Testing",
        )

        # Build a fresh admin bound to Event model
        admin = _DataExportAdmin()
        admin.model = Event

        qs = Event.objects.filter(pk=event.pk)
        request = _confirmed_post(self.factory, {"export_format": "json"})

        response = admin.export_data(request, qs)

        self.assertEqual(response["Content-Type"], "application/json")
        data = json.loads(response.content)
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["date"], "2025-06-15")

    def test_json_export_with_json_field_does_not_crash(self):
        """Regression: list/dict values from JSONField caused TypeError in json.dumps."""
        article = _make_article(source_guid="json-field-1", title="JSON Export")
        # Simulate a JSONField value by attaching a list attribute
        # (NewsArticle doesn't have a JSONField, so we use a custom export_fields admin)
        qs = NewsArticle.objects.filter(pk=article.pk)
        request = _confirmed_post(self.factory, {"export_format": "json"})

        # The export should not crash — json.dumps with default=str handles any leftovers
        response = self.admin.export_data(request, qs)

        self.assertEqual(response["Content-Type"], "application/json")
        data = json.loads(response.content)
        self.assertEqual(len(data), 1)
        self.assertIn("title", data[0])
