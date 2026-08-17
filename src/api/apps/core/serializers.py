"""Serializers for core product endpoints."""

from urllib.parse import urlsplit

from rest_framework import serializers

from apps.core.models import FeedbackSubmission


class FeedbackSubmissionSerializer(serializers.Serializer):
    category = serializers.ChoiceField(choices=FeedbackSubmission.Category.values)
    message = serializers.CharField(max_length=5000, min_length=3, trim_whitespace=True)
    pagePath = serializers.CharField(
        max_length=2000,
        allow_blank=True,
        required=False,
        default="",
    )
    consentToFollowUp = serializers.BooleanField(required=False, default=False)

    # noinspection PyPep8Naming
    def validate_pagePath(self, value):
        """Keep only an in-app path so query strings and fragments cannot leak."""
        if not value:
            return ""
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
            raise serializers.ValidationError("pagePath must be an application path.")
        if len(parsed.path) > 500:
            raise serializers.ValidationError("pagePath must be 500 characters or fewer.")
        return parsed.path
