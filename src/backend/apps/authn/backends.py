from django.contrib.auth import get_user_model
from django.contrib.auth.backends import ModelBackend

from apps.authn.models import ContactEmail


class EmailAuthBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, **kwargs):
        identifier = username or kwargs.get("email")
        if not identifier or password is None:
            return None

        contact = (
            ContactEmail.objects.select_related("member")
            .filter(
                email_address__iexact=identifier,
                verified=True,
                member__access_level=get_user_model().AccessLevel.FULL,
            )
            .first()
        )
        if contact is None:
            get_user_model()().set_password(password)
            return None

        user = contact.member
        if user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None
