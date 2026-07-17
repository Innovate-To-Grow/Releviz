from django import forms

from apps.authn.services import login_with_password

ADMIN_INPUT_CLASSES = (
    "bg-white border border-base-200 font-medium min-w-20 px-3 py-2 rounded-default "
    "shadow-xs w-full focus:outline-2 focus:-outline-offset-2 focus:outline-primary-600 "
    "dark:bg-base-900 dark:border-base-700 dark:text-font-important-dark"
)


class AdminPasswordForm(forms.Form):
    email = forms.EmailField(
        label="Email",
        widget=forms.EmailInput(
            attrs={
                "autocomplete": "email",
                "class": ADMIN_INPUT_CLASSES,
                "placeholder": "admin@releviz.local",
            }
        ),
    )
    password = forms.CharField(
        label="Password",
        strip=False,
        widget=forms.PasswordInput(
            attrs={
                "autocomplete": "current-password",
                "class": ADMIN_INPUT_CLASSES,
                "placeholder": "Password",
            }
        ),
    )

    def __init__(self, request=None, *args, **kwargs):
        self.request = request
        self.user_cache = None
        super().__init__(*args, **kwargs)

    def clean(self):
        cleaned = super().clean()
        email = cleaned.get("email")
        password = cleaned.get("password")
        if email and password:
            try:
                self.user_cache = login_with_password(
                    email,
                    password,
                    request=self.request,
                    require_staff=True,
                )
            except Exception as exc:  # noqa: BLE001
                raise forms.ValidationError(
                    "Please enter valid staff account credentials."
                ) from exc
        return cleaned

    def get_user(self):
        return self.user_cache
