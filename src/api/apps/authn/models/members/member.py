from django.contrib.auth.models import AbstractUser
from django.db import models, router

from apps.core.models import ProjectControlModel
from apps.core.utils.access import user_can_access_app

from .manager import MemberManager


class Member(AbstractUser, ProjectControlModel):
    class AccessLevel(models.TextChoices):
        FULL = "full", "Full"
        TEMPORARY = "temporary", "Temporary"

    username = None

    USERNAME_FIELD = "id"
    REQUIRED_FIELDS = ["first_name", "last_name"]

    objects = MemberManager()

    is_staff = models.BooleanField(
        default=False,
        verbose_name="Administrator",
        help_text="Allows full access to all administration modules and administrator management.",
    )
    # Django's permission machinery expects this flag. It mirrors is_staff and
    # does not represent a separate role or an independently editable permission.
    is_superuser = models.BooleanField(default=False, editable=False)

    # Retain old grants for compatibility with existing records and imports.
    # They no longer participate in authorization or appear in admin forms.
    admin_apps = models.JSONField(
        default=list,
        blank=True,
        editable=False,
        help_text="Legacy app grants; administrators now have access to every app.",
        verbose_name="Legacy admin apps",
    )

    def save(self, *, force_insert=False, force_update=False, using=None, update_fields=None):
        """Keep Django's compatibility flag in step with the administrator role."""
        if update_fields is not None:
            update_fields = frozenset(update_fields)

        if self._state.adding:
            # Accept either legacy flag when creating an administrator.
            self.is_staff = self.is_staff or self.is_superuser

        if update_fields is None:
            # A deferred profile-only save must not fetch and write role fields.
            if "is_staff" in self.__dict__:
                self.is_superuser = self.is_staff
            elif "is_superuser" in self.__dict__:
                self.is_superuser = models.F("is_staff")
        elif "is_staff" in update_fields:
            self.is_superuser = self.is_staff
            update_fields |= {"is_superuser"}
        elif "is_superuser" in update_fields:
            # A compatibility-only write cannot change the role, even from a
            # stale instance. Copy the current database value atomically.
            self.is_superuser = models.F("is_staff")

        refresh_role = isinstance(self.__dict__.get("is_superuser"), models.F)
        super().save(
            force_insert=force_insert,
            force_update=force_update,
            using=using,
            update_fields=update_fields,
        )
        if refresh_role:
            self.refresh_from_db(
                using=using or router.db_for_write(type(self), instance=self),
                fields=["is_staff", "is_superuser"],
            )
        if update_fields is None or {"is_staff", "is_superuser"}.intersection(update_fields):
            # Cached Django permissions must not survive an administrator's demotion.
            for cache_name in ("_perm_cache", "_user_perm_cache", "_group_perm_cache"):
                self.__dict__.pop(cache_name, None)

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
    access_level = models.CharField(
        max_length=16,
        choices=AccessLevel.choices,
        default=AccessLevel.FULL,
        db_index=True,
        help_text="Whether this member has a full account or event-scoped temporary access.",
    )

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

    def display_name(self) -> str:
        """Return the best human-readable label for scheduling views."""
        return self.get_full_name() or self.get_primary_email()

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
