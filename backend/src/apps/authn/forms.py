from django import forms
from django.contrib.auth import authenticate


class AdminPasswordForm(forms.Form):
    email = forms.EmailField(label="Email")
    password = forms.CharField(label="Password", strip=False, widget=forms.PasswordInput)

    def __init__(self, request=None, *args, **kwargs):
        self.request = request
        self.user_cache = None
        super().__init__(*args, **kwargs)

    def clean(self):
        cleaned = super().clean()
        email = cleaned.get("email")
        password = cleaned.get("password")
        if email and password:
            self.user_cache = authenticate(self.request, username=email, password=password)
            if self.user_cache is None or not self.user_cache.is_staff:
                raise forms.ValidationError("Please enter valid staff account credentials.")
        return cleaned

    def get_user(self):
        return self.user_cache
