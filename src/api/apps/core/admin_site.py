from collections.abc import Iterable
from urllib.parse import urlparse

from unfold.sites import UnfoldAdminSite


def _navigation_items(navigation: list[dict]) -> Iterable[dict]:
    for group in navigation:
        for item in group.get("items", []):
            yield item
            yield from _navigation_items([item])


def _item_active_paths(item: dict) -> Iterable[str]:
    configured_paths = item.get("active_paths")
    if configured_paths is None:
        configured_paths = [item.get("link_callback") or item.get("link")]
    elif isinstance(configured_paths, str):
        configured_paths = [configured_paths]

    for value in configured_paths:
        if value is None:
            continue

        path = urlparse(str(value)).path
        if path:
            yield path


def _matches_path(request_path: str, configured_path: str) -> bool:
    prefix = configured_path.rstrip("/")
    return request_path == prefix or request_path.startswith(f"{prefix}/")


def select_current_sidebar_item(navigation: list[dict], request_path: str) -> list[dict]:
    """Keep exactly one sidebar item active for the current admin path."""
    selected = None
    selected_path_length = -1

    for item in _navigation_items(navigation):
        item["active"] = False
        if not item.get("has_permission", True):
            continue

        for configured_path in _item_active_paths(item):
            if _matches_path(request_path, configured_path):
                path_length = len(configured_path)
                if path_length > selected_path_length:
                    selected = item
                    selected_path_length = path_length

    if selected is not None:
        selected["active"] = True

    return navigation


class RelevizAdminSite(UnfoldAdminSite):
    """Unfold admin site with route-specific sidebar selection."""

    def get_sidebar_list(self, request):
        navigation = super().get_sidebar_list(request)
        return select_current_sidebar_item(navigation, request.path)
