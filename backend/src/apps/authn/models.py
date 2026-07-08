import re
import uuid
from datetime import timedelta

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone

from apps.authn.managers import MemberManager
from apps.core.models import TimestampedModel


class Member(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    username = None
    email = models.EmailField(blank=True, default="")
    middle_name = models.CharField(max_length=150, blank=True, default="")
    organization = models.CharField(max_length=255, blank=True, default="")
    title = models.CharField(max_length=255, blank=True, default="")
    profile_image = models.URLField(blank=True, default="")
    admin_apps = models.JSONField(default=list, blank=True)

    USERNAME_FIELD = "id"
    REQUIRED_FIELDS: list[str] = []
    objects = MemberManager()

    class Meta:
        ordering = ["last_name", "first_name", "date_joined"]

    @property
    def created_at(self):
        return self.date_joined

    def get_primary_email(self):
        return self.contact_emails.filter(email_type="primary").first()

    def get_primary_contact_email(self) -> str:
        contact = self.get_primary_email()
        return contact.email_address if contact else self.email

    def display_name(self) -> str:
        return self.get_full_name() or self.get_primary_contact_email() or str(self.pk)

    def get_username(self) -> str:
        return self.get_primary_contact_email() or str(self.pk)

    def can_access_app(self, app_label: str) -> bool:
        if self.is_superuser:
            return True
        return app_label in (self.admin_apps or [])


class ContactEmail(TimestampedModel):
    EMAIL_TYPE_CHOICES = [
        ("primary", "Primary"),
        ("secondary", "Secondary"),
        ("other", "Other"),
    ]

    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="contact_emails",
    )
    email_address = models.EmailField(unique=True)
    email_type = models.CharField(max_length=32, choices=EMAIL_TYPE_CHOICES, default="primary")
    subscribe = models.BooleanField(default=True)
    verified = models.BooleanField(default=False)

    class Meta:
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
            )
        ]

    def clean(self):
        super().clean()
        if self.email_address:
            self.email_address = self.email_address.strip().lower()
            qs = ContactEmail.objects.filter(email_address__iexact=self.email_address).exclude(
                pk=self.pk
            )
            if qs.exists():
                raise ValidationError({"email_address": "This email address is already in use."})

    def __str__(self) -> str:
        state = "verified" if self.verified else "pending"
        return f"{self.email_address} ({state})"


class ContactPhone(TimestampedModel):
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="contact_phones",
    )
    phone_number = models.CharField(max_length=20, unique=True)
    region = models.CharField(max_length=20, default="1-US")
    subscribe = models.BooleanField(default=False)
    verified = models.BooleanField(default=False)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["phone_number"]),
            models.Index(fields=["region"]),
            models.Index(fields=["verified"]),
        ]

    def clean(self):
        super().clean()
        if self.phone_number:
            self.phone_number = self.to_national_digits(self.phone_number, self.region)

    def to_e164(self) -> str:
        country_code = self.region.split("-")[0]
        return f"+{country_code}{self.phone_number}"

    @staticmethod
    def to_national_digits(phone_number: str, region: str) -> str:
        cleaned = re.sub(r"[\s()\-.]", "", phone_number.strip())
        if cleaned.startswith("+"):
            cleaned = cleaned[1:]
        country_code = region.split("-")[0]
        if cleaned.startswith(country_code) and len(cleaned) > len(country_code):
            cleaned = cleaned[len(country_code) :]
        return re.sub(r"\D", "", cleaned)

    def __str__(self) -> str:
        return self.to_e164()


class EmailAuthChallenge(TimestampedModel):
    class Purpose(models.TextChoices):
        REGISTER = "register", "Register"
        LOGIN = "login", "Login"
        PASSWORD_RESET = "password_reset", "Password Reset"
        PASSWORD_CHANGE = "password_change", "Password Change"
        ACCOUNT_DELETE = "account_delete", "Account Delete"
        CONTACT_EMAIL_VERIFY = "contact_email_verify", "Contact Email Verify"
        ADMIN_LOGIN = "admin_login", "Admin Login"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        VERIFIED = "verified", "Verified"
        CONSUMED = "consumed", "Consumed"
        EXPIRED = "expired", "Expired"

    class Channel(models.TextChoices):
        EMAIL = "email", "Email"
        SMS = "sms", "SMS"

    member = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="email_auth_challenges",
    )
    purpose = models.CharField(max_length=32, choices=Purpose.choices)
    channel = models.CharField(max_length=8, choices=Channel.choices, default=Channel.EMAIL)
    target_email = models.EmailField(blank=True, default="")
    target_phone = models.CharField(max_length=20, blank=True, default="")
    code_hash = models.CharField(max_length=255)
    verification_token_hash = models.CharField(max_length=255, blank=True, default="")
    expires_at = models.DateTimeField()
    verified_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=5)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    last_sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["purpose", "target_email", "status"]),
            models.Index(fields=["member", "purpose", "status"]),
            models.Index(fields=["expires_at"]),
        ]

    @classmethod
    def default_expiry(cls):
        return timezone.now() + timedelta(minutes=10)

    @property
    def is_expired(self) -> bool:
        return self.expires_at <= timezone.now()

    def mark_verified(self):
        self.status = self.Status.VERIFIED
        self.verified_at = timezone.now()
        self.save(update_fields=["status", "verified_at", "updated_at"])

    def mark_consumed(self):
        self.status = self.Status.CONSUMED
        self.save(update_fields=["status", "updated_at"])

    def __str__(self) -> str:
        target = self.target_phone if self.channel == self.Channel.SMS else self.target_email
        return f"{self.purpose} -> {target} [{self.status}]"


class RSAKeypair(TimestampedModel):
    key_id = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    name = models.CharField(max_length=255, default="site-encryption")
    public_key_pem = models.TextField(blank=True)
    private_key_pem = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    rotated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    @classmethod
    def generate_keypair(cls, key_size: int = 2048):
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=key_size,
            backend=default_backend(),
        )
        private_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("utf-8")
        public_pem = (
            private_key.public_key()
            .public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            .decode("utf-8")
        )
        return public_pem, private_pem

    def save(self, *args, **kwargs):
        if not self.public_key_pem or not self.private_key_pem:
            self.public_key_pem, self.private_key_pem = self.generate_keypair()
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"{self.name} ({self.key_id})"
