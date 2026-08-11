"""Tests for the shared apps.core building blocks."""

from unittest.mock import Mock

from django.test import SimpleTestCase
from rest_framework import status
from rest_framework.exceptions import NotAuthenticated, ValidationError

from apps.core.models import TimeStampedModel
from apps.core.utils.exceptions import exception_handler
from apps.core.utils.pagination import DefaultPageNumberPagination
from apps.core.utils.permissions import IsOwnerOrReadOnly
from apps.core.utils.serializers import TimeStampedModelSerializer


class TimeStampedModelTests(SimpleTestCase):
    def test_is_abstract_with_timestamp_fields(self):
        self.assertTrue(TimeStampedModel._meta.abstract)
        field_names = {f.name for f in TimeStampedModel._meta.get_fields()}
        self.assertIn("created_at", field_names)
        self.assertIn("updated_at", field_names)

    def test_created_at_is_add_only_and_updated_at_auto(self):
        created = TimeStampedModel._meta.get_field("created_at")
        updated = TimeStampedModel._meta.get_field("updated_at")
        self.assertTrue(created.auto_now_add)
        self.assertTrue(updated.auto_now)


class DefaultPaginationTests(SimpleTestCase):
    def test_page_size_bounds(self):
        pager = DefaultPageNumberPagination()
        self.assertEqual(pager.page_size, 20)
        self.assertEqual(pager.max_page_size, 100)
        self.assertEqual(pager.page_size_query_param, "page_size")


class ExceptionHandlerTests(SimpleTestCase):
    def test_wraps_drf_response_in_error_envelope(self):
        response = exception_handler(ValidationError("bad"), {})
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.data)
        self.assertEqual(response.data["error"]["status_code"], status.HTTP_400_BAD_REQUEST)
        self.assertIn("detail", response.data["error"])

    def test_preserves_status_code(self):
        response = exception_handler(NotAuthenticated(), {})
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(response.data["error"]["status_code"], status.HTTP_401_UNAUTHORIZED)

    def test_returns_none_for_unhandled_exception(self):
        # DRF's default handler returns None for non-API exceptions; we pass it through.
        self.assertIsNone(exception_handler(ValueError("boom"), {}))


class TimeStampedModelSerializerTests(SimpleTestCase):
    def test_declares_timestamp_fields_as_read_only(self):
        # The base class declares the timestamp fields without a Meta.model;
        # subclasses supply Meta, so inspect the declared fields directly.
        declared = TimeStampedModelSerializer._declared_fields
        self.assertIn("created_at", declared)
        self.assertIn("updated_at", declared)
        self.assertTrue(declared["created_at"].read_only)
        self.assertTrue(declared["updated_at"].read_only)


class IsOwnerOrReadOnlyTests(SimpleTestCase):
    def setUp(self):
        self.permission = IsOwnerOrReadOnly()
        self.user = object()

    def _request(self, method):
        req = Mock()
        req.method = method
        req.user = self.user
        return req

    def test_safe_method_allowed_for_anyone(self):
        obj = Mock(owner=object())  # different owner
        self.assertTrue(self.permission.has_object_permission(self._request("GET"), Mock(), obj))

    def test_write_allowed_only_for_owner(self):
        owned = Mock(owner=self.user)
        not_owned = Mock(owner=object())
        self.assertTrue(self.permission.has_object_permission(self._request("PUT"), Mock(), owned))
        self.assertFalse(self.permission.has_object_permission(self._request("PUT"), Mock(), not_owned))
