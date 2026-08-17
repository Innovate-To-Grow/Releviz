from django.core.exceptions import ValidationError
from django.db import models

from apps.core.models import ProjectControlModel


class ContactEmail(ProjectControlModel):
    # owner
    member = models.ForeignKey(
        "authn.Member",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="contact_emails",
        help_text="Member this email belongs to",
        verbose_name="Member",
    )

    # contact email
    email_address = models.EmailField(
        unique=True, help_text="Email address for contact", verbose_name="Email Address"
    )

    # contact email type
    EMAIL_TYPE_CHOICES = [
        ("primary", "Primary"),
        ("secondary", "Secondary"),
        ("other", "Other"),
    ]

    # contact email type
    email_type = models.CharField(
        max_length=255,
        choices=EMAIL_TYPE_CHOICES,
        default="primary",
        help_text="Type of email address",
        verbose_name="Email Type",
    )

    # subscribe
    subscribe = models.BooleanField(
        default=True,
        help_text="Whether the email is subscribed to communications",
        verbose_name="Subscribed",
    )

    # verified
    verified = models.BooleanField(
        default=False,
        help_text="Whether the email address has been verified",
        verbose_name="Verified",
    )

    class Meta:
        verbose_name = "Contact Email"
        verbose_name_plural = "Contact Emails"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["email_address"]),
            models.Index(fields=["email_type"]),
            models.Index(fields=["verified"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["member"],
                condition=models.Q(email_type="primary"),
                name="one_primary_email_per_member",
            ),
        ]

    def clean(self):
        super().clean()
        if self.email_address:
            self.email_address = self.email_address.strip()
            existing = (
                ContactEmail.objects.filter(email_address__iexact=self.email_address)
                .exclude(pk=self.pk)
                .first()
            )
            if existing:
                if self.member_id and existing.member_id == self.member_id:
                    raise ValidationError(
                        {"email_address": "This member already has this email address."}
                    )
                raise ValidationError(
                    {"email_address": "This email address is already assigned to another member."}
                )

        if self.email_type == "primary" and self.member_id:
            qs = ContactEmail.objects.filter(member=self.member, email_type="primary")
            if self.pk:
                qs = qs.exclude(pk=self.pk)
            if qs.exists():
                raise ValidationError({"email_type": "This member already has a primary email."})

    def __str__(self):
        # truncate contact email info tostring
        str_contact_email = f"{self.email_address} - {self.get_email_type_display()}"

        # append subscribe info to string
        if self.subscribe:
            str_contact_email += " - Subscribed"

        # append verified info to string
        if self.verified:
            str_contact_email += " - Verified"

        return str_contact_email
