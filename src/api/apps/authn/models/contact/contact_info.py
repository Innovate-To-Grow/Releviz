import re

from django.core.exceptions import ValidationError
from django.db import models

from apps.authn.models.contact.phone_regions import PHONE_REGION_CHOICES
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
    email_address = models.EmailField(unique=True, help_text="Email address for contact", verbose_name="Email Address")

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
        default=True, help_text="Whether the email is subscribed to communications", verbose_name="Subscribed"
    )

    # verified
    verified = models.BooleanField(
        default=False, help_text="Whether the email address has been verified", verbose_name="Verified"
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
            existing = ContactEmail.objects.filter(email_address__iexact=self.email_address).exclude(pk=self.pk).first()
            if existing:
                if self.member_id and existing.member_id == self.member_id:
                    raise ValidationError({"email_address": "This member already has this email address."})
                raise ValidationError({"email_address": "This email address is already assigned to another member."})

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


class ContactPhone(ProjectControlModel):
    # owner
    member = models.ForeignKey(
        "authn.Member",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="contact_phones",
        help_text="Member this phone belongs to",
        verbose_name="Member",
    )

    # contact phone number
    phone_number = models.CharField(max_length=20, unique=True, help_text="National digits only (e.g. 2095765113)")

    # contact phone region (US-only; AWS SNS only delivers to US numbers)
    region = models.CharField(
        max_length=20, choices=PHONE_REGION_CHOICES, default="1-US", help_text="Region of the phone number"
    )

    # subscribe
    subscribe = models.BooleanField(
        default=False, help_text="Whether the phone number is subscribed to communications", verbose_name="Subscribed"
    )
    verified = models.BooleanField(
        default=False,
        help_text="Whether the phone number has been verified",
        verbose_name="Verified",
    )

    class Meta:
        verbose_name = "Contact Phone"
        verbose_name_plural = "Contact Phones"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["phone_number"]),
            models.Index(fields=["region"]),
            models.Index(fields=["subscribe"]),
            models.Index(fields=["verified"]),
        ]

    def clean(self):
        super().clean()
        if self.phone_number and self.region:
            self.phone_number = self._to_national_digits(self.phone_number, self.region)
            existing = ContactPhone.objects.filter(phone_number=self.phone_number).exclude(pk=self.pk).first()
            if existing:
                if self.member_id and existing.member_id == self.member_id:
                    raise ValidationError({"phone_number": "This member already has this phone number."})
                raise ValidationError({"phone_number": "This phone number is already assigned to another member."})

    def __str__(self):
        region_display = self.get_region_display_name()
        str_contact_phone = f"{self.phone_number} ({region_display})"

        if self.subscribe:
            str_contact_phone += " - Subscribed"
        if self.verified:
            str_contact_phone += " - Verified"

        return str_contact_phone

    def to_e164(self) -> str:
        """Reconstruct the full E.164 number from national digits + region."""
        cc = self.region.split("-")[0] if "-" in self.region else self.region
        return f"+{cc}{self.phone_number}"

    def get_formatted_number(self):
        """Return a human-readable formatted phone number."""
        cc = self.region.split("-")[0] if "-" in self.region else self.region
        n = self.phone_number

        if cc == "1" and len(n) == 10:
            return f"({n[:3]}){n[3:6]}-{n[6:]}"

        return n

    # get region display name
    def get_region_display_name(self):
        """
        Return the display name for the region.
        """
        region_dict = dict(PHONE_REGION_CHOICES)
        return region_dict.get(self.region, self.region)

    @staticmethod
    def _to_national_digits(phone_number: str, region: str) -> str:
        cleaned = re.sub(r"[\s()\-.]", "", phone_number.strip())
        if cleaned.startswith("+"):
            cleaned = cleaned[1:]
        country_code = region.split("-")[0] if "-" in region else region
        if cleaned.startswith(country_code) and len(cleaned) > len(country_code):
            cleaned = cleaned[len(country_code) :]
        return re.sub(r"\D", "", cleaned)
