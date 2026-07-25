"""Privacy retention procedures for user-submitted support data."""

from django.conf import settings

from apps.core.models import FeedbackSubmission


def prune_feedback_submissions(*, as_of) -> int:
    cutoff = as_of - settings.FEEDBACK_SUBMISSION_RETENTION
    return FeedbackSubmission.objects.filter(created_at__lt=cutoff).delete()[0]
