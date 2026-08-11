from django.contrib.auth.models import AbstractUser
from django.db import models

from apps.core.models import ProjectControlModel
from apps.core.utils.access import user_can_access_app

from .manager import MemberManager


class Member(AbstractUser, ProjectControlModel):
    username = None

    USERNAME_FIELD = "id"
    REQUIRED_FIELDS = ["first_name", "last_name"]

    objects = MemberManager()

    # Per-Django-app admin access. A staff member may manage every model in any app
    # listed here (e.g. ["cms", "event"]). Superusers (I2G Master) ignore this list.
    # See apps.core.utils.access.user_can_access_app — the single enforcement predicate.
    admin_apps = models.JSONField(
        default=list,
        blank=True,
        help_text='Django apps this admin may manage (e.g. ["cms", "event"]). Superusers ignore this.',
        verbose_name="Admin apps",
    )

    def can_access_app(self, app_label: str) -> bool:
        """Whether this member may manage records in the Django app ``app_label``."""
        return user_can_access_app(self, app_label)

    def get_username(self):
        """Return UUID as a string so templates and admin can handle it."""
        return str(self.id)

    def __str__(self):
        return self.get_full_name() or self.get_primary_email() or str(self.id)

    # add field for user models
    middle_name = models.CharField(max_length=255, null=True, blank=True, help_text="Middle Name")

    @property
    def member_uuid(self):
        """Return the member's UUID (alias for id from ProjectControlModel)."""
        return self.id

    @property
    def has_required_name_fields(self) -> bool:
        """Return whether the member has the required first and last name fields."""
        return bool((self.first_name or "").strip() and (self.last_name or "").strip())

    @property
    def requires_profile_completion(self) -> bool:
        """Return whether the member must complete their profile before continuing."""
        return not self.has_required_name_fields

    # organization
    organization = models.CharField(
        max_length=255,
        null=True,
        blank=True,
        help_text="Organization or company the member belongs to",
        verbose_name="Organization",
    )

    # job title or position
    title = models.CharField(
        max_length=255,
        null=True,
        blank=True,
        help_text="Job title or position within the organization",
        verbose_name="Title",
    )

    # profile image (base64 encoded)
    profile_image = models.TextField(
        null=True,
        blank=True,
        help_text="Profile image, base64-encoded.",
        verbose_name="Profile Image",
    )

    # get full name including middle name
    def get_full_name(self):
        """
        Return the first_name plus the middle_name plus the last_name, with a space in between.
        """
        full_name = self.first_name
        if self.middle_name:
            full_name += f" {self.middle_name}"
        if self.last_name:
            full_name += f" {self.last_name}"
        return full_name.strip()

    def _primary_contact_from_prefetch(self):
        """Return the primary ContactEmail from the prefetch cache, or None if not prefetched."""
        cache = getattr(self, "_prefetched_objects_cache", None)
        if not cache or "contact_emails" not in cache:
            return None
        primaries = [c for c in cache["contact_emails"] if c.email_type == "primary"]
        if not primaries:
            return None
        primaries.sort(key=lambda c: c.created_at)
        return primaries[0]

    def get_primary_email(self) -> str:
        """Return the primary ContactEmail address, or empty string."""
        prefetched = self._primary_contact_from_prefetch()
        if prefetched is not None:
            return prefetched.email_address
        contact = self.contact_emails.filter(email_type="primary").order_by("created_at").first()
        return contact.email_address if contact else ""

    def get_primary_contact_email(self):
        """Return the primary ContactEmail object, or None."""
        prefetched = self._primary_contact_from_prefetch()
        if prefetched is not None:
            return prefetched
        return self.contact_emails.filter(email_type="primary").order_by("created_at").first()

    def _primary_phone_from_prefetch(self):
        """Return the primary ContactPhone from the prefetch cache, or None if not prefetched.

        Mirrors :meth:`_primary_contact_from_prefetch`: verified phones sort first
        (``-verified``), then earliest ``created_at``.
        """
        cache = getattr(self, "_prefetched_objects_cache", None)
        if not cache or "contact_phones" not in cache:
            return None
        phones = list(cache["contact_phones"])
        if not phones:
            return None
        phones.sort(key=lambda p: (-p.verified, p.created_at))
        return phones[0]

    def get_primary_phone(self) -> str:
        """Return the member's primary phone in E.164, or empty string.

        ContactPhone has no ``phone_type`` (unlike ContactEmail), so pick
        deterministically: verified phones sort first (``-verified``), then the
        earliest within that group — i.e. the earliest verified phone, else the
        earliest phone overall. When ``contact_phones`` is prefetched the result
        is computed in-process with zero extra queries.
        """
        prefetched = self._primary_phone_from_prefetch()
        if prefetched is not None:
            return prefetched.to_e164()
        contact = self.contact_phones.order_by("-verified", "created_at").first()
        return contact.to_e164() if contact else ""
