"""
Base serializer classes.

Building blocks for app serializers. Nothing here is wired in globally.
"""

from rest_framework import serializers


class TimeStampedModelSerializer(serializers.ModelSerializer):
    """ModelSerializer that exposes ``created_at`` / ``updated_at`` as read-only.

    Pair with ``apps.core.models.TimeStampedModel``. Subclasses set their own
    ``Meta.model`` / ``Meta.fields``; the timestamp fields below are merged in
    as read-only when listed in ``fields``.
    """

    created_at = serializers.DateTimeField(read_only=True)
    updated_at = serializers.DateTimeField(read_only=True)
