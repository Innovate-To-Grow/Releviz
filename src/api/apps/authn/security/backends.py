from django.contrib.auth.backends import ModelBackend

from apps.authn.models import ContactEmail


class EmailAuthBackend(ModelBackend):
    """
    Authenticate by email via ContactEmail (verified).
    """

    # noinspection PyUnusedLocal
    def authenticate(self, request, username=None, password=None, **kwargs):
        if username is None:
            username = kwargs.get("email")
        if not username or password is None:
            return None

        contact = (
            ContactEmail.objects.select_related("member").filter(email_address__iexact=username, verified=True).first()
        )
        if contact is None:
            return None

        user = contact.member
        if user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None
