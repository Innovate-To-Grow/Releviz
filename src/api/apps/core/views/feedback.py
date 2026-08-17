"""In-product feedback intake."""

import logging
import uuid

from django.utils.cache import patch_cache_control
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security import AuthRateThrottle
from apps.core.models import FeedbackSubmission
from apps.core.serializers import FeedbackSubmissionSerializer

logger = logging.getLogger(__name__)


class FeedbackView(APIView):
    """Accept feedback from signed-in members and anonymous visitors alike."""

    permission_classes = [AllowAny]
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "feedback"
    auth_rate_methods = {"POST"}

    # noinspection PyMethodMayBeStatic
    def get_auth_rate_identity(self, request):
        return str(request.user.pk) if request.user.is_authenticated else ""

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = FeedbackSubmissionSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        request_id = getattr(request, "request_id", "")
        feedback = FeedbackSubmission.objects.create(
            category=serializer.validated_data["category"],
            message=serializer.validated_data["message"],
            page_path=serializer.validated_data["pagePath"],
            member=request.user if request.user.is_authenticated else None,
            consent_to_follow_up=serializer.validated_data["consentToFollowUp"],
            request_id=uuid.UUID(request_id) if request_id else None,
        )
        logger.info(
            "feedback_submitted",
            extra={
                "feedback_id": str(feedback.pk),
                "category": feedback.category,
                "member_id": str(feedback.member_id) if feedback.member_id else None,
            },
        )
        response = Response(
            {"id": str(feedback.pk), "status": "received"},
            status=status.HTTP_201_CREATED,
        )
        # Feedback is personal and must never be cached by a shared proxy.
        patch_cache_control(response, private=True, no_store=True)
        return response
