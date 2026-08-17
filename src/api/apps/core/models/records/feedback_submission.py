from django.conf import settings
from django.db import models

from ..base import TimeStampedModel


class FeedbackSubmission(TimeStampedModel):
    """In-product feedback, optionally attributed to the signed-in member."""

    class Category(models.TextChoices):
        PROBLEM = "problem", "Problem"
        IDEA = "idea", "Idea"
        USABILITY = "usability", "Usability"
        OTHER = "other", "Other"

    class Status(models.TextChoices):
        NEW = "new", "New"
        REVIEWING = "reviewing", "Reviewing"
        RESOLVED = "resolved", "Resolved"

    category = models.CharField(max_length=16, choices=Category.choices)
    message = models.CharField(max_length=5000)
    page_path = models.CharField(max_length=500, blank=True, default="")
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="feedback_submissions",
    )
    consent_to_follow_up = models.BooleanField(default=False)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.NEW)
    request_id = models.UUIDField(null=True, blank=True)

    class Meta:
        verbose_name = "Feedback Submission"
        verbose_name_plural = "Feedback Submissions"
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(category__in=["problem", "idea", "usability", "other"]),
                name="feedback_category_is_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["new", "reviewing", "resolved"]),
                name="feedback_status_is_valid",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "created_at"]),
            models.Index(fields=["category", "created_at"]),
            models.Index(fields=["member", "created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.get_category_display()} feedback [{self.status}]"
