from django.contrib.auth.hashers import make_password
from django.contrib.auth.models import BaseUserManager

from apps.core.models.managers.base import ProjectControlQuerySet


class MemberManager(BaseUserManager):
    """Custom manager for Member without a username field."""

    use_in_migrations = True

    @staticmethod
    def _normalize_required_name(value, field_name: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            raise ValueError(f"Superuser {field_name} is required.")
        return normalized

    def get_queryset(self):
        return ProjectControlQuerySet(self.model, using=self._db)

    def _create_user(self, password=None, **extra_fields):
        user = self.model(**extra_fields)
        user.password = make_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(password, **extra_fields)

    def create_superuser(self, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)

        if extra_fields.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")

        extra_fields["first_name"] = self._normalize_required_name(extra_fields.get("first_name"), "first name")
        extra_fields["last_name"] = self._normalize_required_name(extra_fields.get("last_name"), "last name")

        return self._create_user(password, **extra_fields)
