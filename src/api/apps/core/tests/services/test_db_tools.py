"""Tests for the System Intelligence database query tools."""

import json

from django.test import TestCase
from django.utils import timezone

from apps.core.services.db_tools import execute_tool, get_tool_definitions
from apps.core.services.db_tools.tool_modules.analytics import get_page_views
from apps.core.services.db_tools.tool_modules.cms import search_cms_pages, search_news
from apps.core.services.db_tools.tool_modules.custom.query import (
    allowed_output_fields,
    apply_filters,
    apply_ordering,
    is_allowed_query_key,
    run_custom_query,
    serialize_custom_rows,
    validate_output_fields,
)
from apps.core.services.db_tools.tool_modules.events import (
    get_checkin_stats,
    get_event_registrations,
    search_events,
)
from apps.core.services.db_tools.tool_modules.helpers import _serialize_rows, _truncate
from apps.core.services.db_tools.tool_modules.mail import get_campaign_stats, search_email_campaigns
from apps.core.services.db_tools.tool_modules.members import count_members, search_members
from apps.core.services.db_tools.tool_modules.projects import search_projects, search_semesters

# ---------- helpers ----------


class HelpersTest(TestCase):
    def test_truncate_short_text_unchanged(self):
        self.assertEqual(_truncate("hello", limit=100), "hello")

    def test_truncate_long_text(self):
        text = "x" * 50
        result = _truncate(text, limit=10)
        self.assertTrue(result.startswith("x" * 10))
        self.assertIn("truncated, 50 total chars", result)

    def test_serialize_rows_serializes_datetime_and_uuid(self):
        from apps.projects.models import Semester

        Semester.objects.create(year=2025, season=1, is_published=True)
        result = _serialize_rows(Semester.objects.all(), ["id", "year", "created_at"])
        self.assertIn("Showing 1 of 1 result(s).", result)
        payload = json.loads(result.split("\n", 1)[1])
        # id is a UUID -> serialized as string; created_at is a datetime -> isoformat string.
        self.assertIsInstance(payload[0]["id"], str)
        self.assertIsInstance(payload[0]["created_at"], str)


# ---------- executor ----------


class ExecuteToolTest(TestCase):
    def test_unknown_tool(self):
        self.assertEqual(execute_tool({"name": "nope"}), "Unknown tool: nope")

    def test_known_tool_runs(self):
        from apps.projects.models import Semester

        Semester.objects.create(year=2025, season=1, is_published=True)
        result = execute_tool({"name": "search_semesters", "input": {"year": 2025}})
        self.assertIn("2025", result)

    def test_tool_error_is_caught(self):
        # search_projects with a bad filter type triggers an exception inside the tool;
        # use run_custom_query via execute_tool with an unknown model to hit the success path,
        # then force an error by patching the registry function.
        from unittest.mock import patch

        def boom(_params):
            raise ValueError("kaboom")

        with patch.dict(
            "apps.core.services.db_tools.tool_modules.executor.TOOL_REGISTRY",
            {"boomtool": boom},
        ):
            result = execute_tool({"name": "boomtool", "input": {}})
        self.assertIn("Tool error: kaboom", result)


# ---------- definitions ----------


class DefinitionsTest(TestCase):
    def test_returns_list_of_tool_defs(self):
        defs = get_tool_definitions()
        self.assertIsInstance(defs, list)
        self.assertGreater(len(defs), 0)

    def test_search_events_contract_uses_registration_and_date_range(self):
        definition = next(item for item in get_tool_definitions() if item["toolSpec"]["name"] == "search_events")
        properties = definition["toolSpec"]["inputSchema"]["json"]["properties"]

        self.assertNotIn("is_live", properties)
        self.assertIn("registration_open", properties)
        self.assertIn("date_from", properties)
        self.assertIn("date_to", properties)


# ---------- analytics ----------


class AnalyticsTest(TestCase):
    def _make_view(self, path="/home/"):
        from apps.cms.models import PageView

        return PageView.objects.create(path=path, timestamp=timezone.now())

    def test_count_only(self):
        self._make_view()
        self._make_view("/about/")
        result = get_page_views({"count_only": True})
        self.assertEqual(result, "Page view count: 2")

    def test_filters_and_summary(self):
        self._make_view("/blog/")
        result = get_page_views(
            {
                "path": "blog",
                "date_from": "2000-01-01T00:00:00+00:00",
                "date_to": "2999-01-01T00:00:00+00:00",
            }
        )
        self.assertIn("Total views: 1", result)
        self.assertIn("Top pages:", result)


# ---------- cms ----------


class CmsToolsTest(TestCase):
    def test_search_cms_pages_filters(self):
        from apps.cms.models import CMSPage

        CMSPage.objects.create(title="About Us", slug="about", route="/about", status="published")
        result = search_cms_pages({"title": "About", "slug": "about", "status": "published"})
        self.assertIn("About Us", result)

    def test_search_news_filters(self):
        from apps.cms.models import NewsArticle

        NewsArticle.objects.create(
            source="rss",
            source_guid="g1",
            title="Big News",
            source_url="https://x.com",
            published_at=timezone.now(),
        )
        result = search_news(
            {
                "title": "Big",
                "source": "rss",
                "date_from": "2000-01-01T00:00:00+00:00",
                "date_to": "2999-01-01T00:00:00+00:00",
            }
        )
        self.assertIn("Big News", result)


# ---------- events ----------


class EventsToolsTest(TestCase):
    def _make_event(self, name="Demo Day", date="2025-06-15", end_date=None):
        from apps.event.models import Event

        return Event.objects.create(
            name=name,
            slug=name.lower().replace(" ", "-"),
            date=date,
            end_date=end_date or date,
            location="Hall",
        )

    def _make_registration(self, event, email="ann@example.com"):
        from apps.authn.models import Member
        from apps.event.models import EventRegistration, Ticket

        member = Member.objects.create(first_name="Ann", last_name="Lee", organization="Acme")
        ticket = Ticket.objects.create(event=event, name="General", order=1)
        return EventRegistration.objects.create(
            member=member,
            event=event,
            ticket=ticket,
            attendee_first_name="Ann",
            attendee_last_name="Lee",
            attendee_email=email,
        )

    def test_search_events_filters(self):
        self._make_event()
        result = search_events({"name": "Demo", "date_from": "2000-01-01", "date_to": "2999-01-01"})
        self.assertIn("Demo Day", result)
        self.assertIn('"end_date": "2025-06-15"', result)
        self.assertNotIn('"is_live"', result)

    def test_search_events_date_window_matches_overlapping_event_ranges(self):
        self._make_event("Overlapping", date="2025-05-30", end_date="2025-06-03")
        self._make_event("Before", date="2025-05-01", end_date="2025-05-31")
        self._make_event("After", date="2025-06-02", end_date="2025-06-10")

        result = search_events({"date_from": "2025-06-01", "date_to": "2025-06-01"})

        self.assertIn("Overlapping", result)
        self.assertNotIn("Before", result)
        self.assertNotIn("After", result)

    def test_search_events_resolves_transitional_null_end_date(self):
        from apps.event.models import Event

        event = self._make_event("Legacy task Event", date="2025-06-01")
        Event.objects.filter(pk=event.pk).update(end_date=None)

        result = search_events({"date_from": "2025-06-01", "date_to": "2025-06-01"})

        self.assertIn("Legacy task Event", result)
        self.assertIn('"end_date": "2025-06-01"', result)

    def test_search_events_filters_by_registration_open(self):
        from apps.event.models import Event

        self._make_event()
        Event.objects.create(
            name="Open Day",
            slug="open-day",
            date="2025-07-15",
            end_date="2025-07-15",
            location="Hall",
            registration_open=True,
        )

        result = search_events({"registration_open": True})

        self.assertIn("Open Day", result)
        self.assertNotIn("Demo Day", result)

    def test_get_event_registrations_count_only(self):
        event = self._make_event()
        self._make_registration(event)
        result = get_event_registrations({"event_name": "Demo", "count_only": True})
        self.assertEqual(result, "Registration count: 1")

    def test_get_event_registrations_rows(self):
        event = self._make_event()
        self._make_registration(event)
        result = get_event_registrations({"event_id": str(event.pk)})
        self.assertIn("ann@example.com", result)

    def test_get_checkin_stats(self):
        event = self._make_event()
        registration = self._make_registration(event)
        from apps.event.models import CheckIn, CheckInRecord

        check_in = CheckIn.objects.create(event=event, name="Main Door")
        CheckInRecord.objects.create(check_in=check_in, registration=registration)
        result = get_checkin_stats({"event_name": "Demo"})
        self.assertIn("Total check-ins: 1", result)
        self.assertIn("Main Door", result)

    def test_get_checkin_stats_by_event_id(self):
        event = self._make_event()
        registration = self._make_registration(event)
        from apps.event.models import CheckIn, CheckInRecord

        check_in = CheckIn.objects.create(event=event, name="Side Door")
        CheckInRecord.objects.create(check_in=check_in, registration=registration)
        result = get_checkin_stats({"event_id": str(event.pk)})
        self.assertIn("Total check-ins: 1", result)
        self.assertIn("Side Door", result)


# ---------- mail ----------


class MailToolsTest(TestCase):
    def _make_campaign(self, name="Spring Blast"):
        from apps.mail.models import EmailCampaign

        return EmailCampaign.objects.create(name=name, subject="Hi", status="draft")

    def test_search_email_campaigns(self):
        self._make_campaign()
        result = search_email_campaigns({"name": "Spring", "status": "draft", "subject": "Hi"})
        self.assertIn("Spring Blast", result)

    def test_campaign_stats_not_found(self):
        result = get_campaign_stats({"campaign_name": "nonexistent"})
        self.assertEqual(result, "No campaign found matching the criteria.")

    def test_campaign_stats_found(self):
        campaign = self._make_campaign()
        from apps.mail.models import RecipientLog

        RecipientLog.objects.create(campaign=campaign, status="sent")
        result = get_campaign_stats({"campaign_id": str(campaign.pk)})
        self.assertIn("Campaign: Spring Blast", result)
        self.assertIn("Delivery breakdown", result)


# ---------- members ----------


class MembersToolsTest(TestCase):
    def _make_member(self, first="Jane", last="Doe", org="Acme"):
        from apps.authn.models import Member

        return Member.objects.create(first_name=first, last_name=last, organization=org, is_staff=False)

    def test_search_members_by_name_and_org(self):
        member = self._make_member()
        from apps.authn.models import ContactEmail

        ContactEmail.objects.create(member=member, email_address="jane@acme.com", email_type="primary")
        result = search_members(
            {
                "name": "Jane Doe",
                "email": "jane@acme",
                "organization": "Acme",
                "is_staff": False,
                "is_active": True,
            }
        )
        self.assertIn("Jane", result)

    def test_count_members(self):
        self._make_member()
        self._make_member(first="Bob", org="Beta")
        result = count_members({"is_staff": False, "is_active": True, "organization": "Acme"})
        self.assertEqual(result, "Count: 1")


# ---------- projects ----------


class ProjectsToolsTest(TestCase):
    def _make_project(self):
        from apps.projects.models import Project, Semester

        semester = Semester.objects.create(year=2025, season=1, is_published=True, label="Spring 2025")
        return Project.objects.create(
            project_title="Smart Garden",
            team_name="Green Team",
            team_number=3,
            class_code="ENGR101",
            organization="Acme",
            industry="AgTech",
            semester=semester,
        )

    def test_search_projects_all_filters(self):
        self._make_project()
        result = search_projects(
            {
                "title": "Smart",
                "team_name": "Green",
                "organization": "Acme",
                "industry": "AgTech",
                "semester": "Spring",
                "class_code": "ENGR",
            }
        )
        self.assertIn("Smart Garden", result)

    def test_search_semesters(self):
        from apps.projects.models import Semester

        Semester.objects.create(year=2025, season=1, is_published=True, label="Spring 2025")
        result = search_semesters({"year": 2025, "season": "1", "is_published": True})
        self.assertIn("2025", result)


# ---------- custom query ----------


class CustomQueryKeyTest(TestCase):
    def test_too_many_parts_rejected(self):
        self.assertFalse(is_allowed_query_key("Semester", "year__gte__extra"))

    def test_field_not_in_allowlist_rejected(self):
        self.assertFalse(is_allowed_query_key("Semester", "secret_field"))

    def test_unsafe_lookup_rejected(self):
        self.assertFalse(is_allowed_query_key("Semester", "year__regex"))

    def test_valid_field_and_lookup_accepted(self):
        self.assertTrue(is_allowed_query_key("Semester", "year__gte"))
        self.assertTrue(is_allowed_query_key("Semester", "-year"))

    def test_allowed_output_fields_sorted(self):
        fields = allowed_output_fields("Semester")
        self.assertEqual(fields, sorted(fields))

    def test_event_allowlist_exposes_date_range_without_legacy_live_flag(self):
        fields = allowed_output_fields("Event")

        self.assertIn("date", fields)
        self.assertIn("end_date", fields)
        self.assertNotIn("is_live", fields)

    def test_validate_output_fields_invalid(self):
        msg = validate_output_fields("Semester", ["year", "nope"])
        self.assertIn("field 'nope' is not allowed", msg)

    def test_validate_output_fields_valid(self):
        self.assertEqual(validate_output_fields("Semester", ["year"]), "")


class RunCustomQueryTest(TestCase):
    def _make_semester(self, **kw):
        from apps.projects.models import Semester

        defaults = {"year": 2025, "season": 1, "is_published": True, "label": "Spring 2025"}
        defaults.update(kw)
        return Semester.objects.create(**defaults)

    def test_unknown_model(self):
        result = run_custom_query({"model": "Unicorn"})
        self.assertIn("Unknown model 'Unicorn'", result)

    def test_count_only(self):
        self._make_semester()
        self._make_semester(year=2024)
        result = run_custom_query({"model": "Semester", "count_only": True})
        self.assertEqual(result, "Count: 2")

    def test_filter_error_for_disallowed_field(self):
        result = run_custom_query({"model": "Semester", "filters": {"secret": 1}})
        self.assertIn("Filter error: field 'secret' is not allowed", result)

    def test_ordering_error_for_disallowed_field(self):
        result = run_custom_query({"model": "Semester", "ordering": "secret"})
        self.assertIn("Ordering error: field 'secret' is not allowed", result)

    def test_explicit_fields(self):
        self._make_semester()
        result = run_custom_query({"model": "Semester", "fields": ["year", "label"], "filters": {"year": 2025}})
        self.assertIn("2025", result)
        self.assertIn('"label"', result)

    def test_invalid_explicit_fields(self):
        self._make_semester()
        result = run_custom_query({"model": "Semester", "fields": ["nope"]})
        self.assertIn("field 'nope' is not allowed", result)

    def test_default_fields_serialization(self):
        self._make_semester()
        result = run_custom_query({"model": "Semester", "ordering": ["-year"]})
        self.assertIn("result(s) from Semester", result)
        self.assertIn("2025", result)

    def test_apply_filters_with_non_dict_returns_qs(self):
        from apps.projects.models import Semester

        qs = Semester.objects.all()
        self.assertIs(apply_filters(qs, "Semester", []), qs)

    def test_apply_filters_runtime_error(self):
        from apps.projects.models import Semester

        qs = Semester.objects.all()
        # 'year' is an allowed integer field; a non-numeric value raises during
        # .filter() value coercion, exercising the `Filter error: {exc}` branch.
        result = apply_filters(qs, "Semester", {"year": "not-an-int"})
        self.assertIsInstance(result, str)
        self.assertTrue(result.startswith("Filter error:"))

    def test_apply_ordering_string_normalized(self):
        from apps.projects.models import Semester

        self._make_semester()
        qs = apply_ordering(Semester.objects.all(), "Semester", "-year")
        self.assertTrue(hasattr(qs, "order_by"))
        list(qs)  # force evaluation

    def test_apply_ordering_runtime_error(self):
        from unittest.mock import MagicMock

        from apps.projects.models import Semester

        qs = Semester.objects.all()
        broken = MagicMock(wraps=qs)
        broken.order_by.side_effect = RuntimeError("bad ordering")
        result = apply_ordering(broken, "Semester", "year")
        self.assertEqual(result, "Ordering error: bad ordering")

    def test_serialize_custom_rows_respects_limit(self):
        from apps.projects.models import Semester

        for y in range(2020, 2025):
            self._make_semester(year=y)
        result = serialize_custom_rows(Semester.objects.all(), "Semester", {"limit": 2, "fields": ["year"]})
        self.assertIn("Showing 2 of 5", result)
