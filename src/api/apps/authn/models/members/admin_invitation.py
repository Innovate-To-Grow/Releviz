"""
Admin invitation model for inviting admin users via email.
"""

import secrets

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import ProjectControlModel


class AdminInvitation(ProjectControlModel):
    """Tracks email invitations for admin registration."""

    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        EXPIRED = "expired", "Expired"
        CANCELLED = "cancelled", "Cancelled"

    email = models.EmailField()
    token = models.CharField(max_length=64, unique=True, db_index=True, editable=False)
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.ADMIN)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sent_invitations",
    )
    accepted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="accepted_invitations",
    )
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    message = models.TextField(blank=True, help_text="Optional note included in the invitation email.")

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Admin Invitation"
        verbose_name_plural = "Admin Invitations"

    def __str__(self):
        return f"{self.email} ({self.get_role_display()}) — {self.get_status_display()}"

    @property
    def is_expired(self):
        return timezone.now() >= self.expires_at

    @property
    def is_valid(self):
        return self.status == self.Status.PENDING and not self.is_expired

    def mark_accepted(self, member):
        self.status = self.Status.ACCEPTED
        self.accepted_by = member
        self.accepted_at = timezone.now()
        self.save(update_fields=["status", "accepted_by", "accepted_at", "updated_at"])

    def mark_expired(self):
        self.status = self.Status.EXPIRED
        self.save(update_fields=["status", "updated_at"])

    def mark_cancelled(self):
        self.status = self.Status.CANCELLED
        self.save(update_fields=["status", "updated_at"])

    def get_acceptance_url(self, request=None):
        from django.urls import reverse

        path = reverse("authn:accept-invitation", kwargs={"token": self.token})
        if request:
            return request.build_absolute_uri(path)
        return path

    @staticmethod
    def generate_token():
        return secrets.token_urlsafe(48)

    @staticmethod
    def default_expiry():
        return timezone.now() + timezone.timedelta(days=7)
