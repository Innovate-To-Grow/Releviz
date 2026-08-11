"""
Reusable DRF permission classes.

Building blocks for views that need object-level ownership checks. Apply
per-view via ``permission_classes``; nothing here is enabled globally.
"""

from rest_framework.permissions import SAFE_METHODS, BasePermission


class IsOwnerOrReadOnly(BasePermission):
    """Allow read to anyone; write only to the object's owner.

    Looks up ownership via an ``owner`` attribute by default; override
    ``owner_field`` on a subclass to point at a different attribute (e.g.
    ``"member"`` or ``"created_by"``).
    """

    owner_field = "owner"

    def has_object_permission(self, request, view, obj):
        if request.method in SAFE_METHODS:
            return True
        return getattr(obj, self.owner_field, None) == request.user
