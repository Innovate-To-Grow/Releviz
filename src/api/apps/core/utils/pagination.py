"""
Default pagination class.

Opt-in building block. It is NOT wired into ``REST_FRAMEWORK`` globally — no
list endpoint paginates today, and enabling a global default would change every
list response shape (and break the frontend, which expects unpaginated lists).
Apply it per-view via ``pagination_class`` where pagination is wanted.
"""

from rest_framework.pagination import PageNumberPagination


class DefaultPageNumberPagination(PageNumberPagination):
    """Page-number pagination with a client-overridable page size."""

    page_size = 20
    page_size_query_param = "page_size"
    max_page_size = 100
