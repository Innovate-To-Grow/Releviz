"""Operational and feedback endpoints."""

import hmac
import logging
import uuid

from django.conf import settings
from django.http import HttpResponse
from django.utils.cache import patch_cache_control
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security import AuthRateThrottle
from apps.core.analytics import build_product_metrics, prometheus_product_metrics
from apps.core.models import FeedbackSubmission
from apps.core.serializers import FeedbackSubmissionSerializer

logger = logging.getLogger(__name__)


class FeedbackView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "feedback"
    auth_rate_methods = {"POST"}

    def get_auth_rate_identity(self, request):
        return str(request.user.pk) if request.user.is_authenticated else ""

    def post(self, request):
        serializer = FeedbackSubmissionSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)
        request_id = getattr(request, "request_id", "")
        parsed_request_id = uuid.UUID(request_id) if request_id else None
        feedback = FeedbackSubmission.objects.create(
            category=serializer.validated_data["category"],
            message=serializer.validated_data["message"],
            page_path=serializer.validated_data["pagePath"],
            member=request.user if request.user.is_authenticated else None,
            consent_to_follow_up=serializer.validated_data["consentToFollowUp"],
            request_id=parsed_request_id,
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
            {
                "id": str(feedback.pk),
                "status": "received",
            },
            status=201,
        )
        patch_cache_control(response, private=True, no_store=True)
        return response


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def product_metrics(request):
    configured_token = settings.METRICS_BEARER_TOKEN
    if not configured_token:
        return Response({"detail": "Metrics are not configured."}, status=503)
    authorization = request.headers.get("Authorization", "")
    supplied_token = authorization[7:] if authorization.startswith("Bearer ") else ""
    if not supplied_token or not hmac.compare_digest(supplied_token, configured_token):
        return Response({"detail": "Authentication credentials were not provided."}, status=401)
    body = prometheus_product_metrics(build_product_metrics(window_days=30))
    response = HttpResponse(body, content_type="text/plain; version=0.0.4; charset=utf-8")
    patch_cache_control(response, private=True, no_store=True)
    return response
