from django.urls import path

from apps.authn import views

urlpatterns = [
    path("public-key/", views.PublicKeyView.as_view(), name="authn-public-key"),
    path("register/", views.RegisterView.as_view(), name="authn-register"),
    path(
        "register/verify-code/",
        views.RegisterVerifyCodeView.as_view(),
        name="authn-register-verify",
    ),
    path(
        "register/resend-code/",
        views.RegisterResendCodeView.as_view(),
        name="authn-register-resend",
    ),
    path("login/", views.LoginView.as_view(), name="authn-login"),
    path(
        "login/request-code/", views.LoginRequestCodeView.as_view(), name="authn-login-request-code"
    ),
    path("login/verify-code/", views.LoginVerifyCodeView.as_view(), name="authn-login-verify-code"),
    path(
        "email-auth/request-code/",
        views.LoginRequestCodeView.as_view(),
        name="authn-email-request-code",
    ),
    path(
        "email-auth/verify-code/",
        views.LoginVerifyCodeView.as_view(),
        name="authn-email-verify-code",
    ),
    path(
        "phone-auth/request-code/",
        views.PhoneAuthRequestCodeView.as_view(),
        name="authn-phone-request-code",
    ),
    path(
        "phone-auth/verify-code/",
        views.PhoneAuthVerifyCodeView.as_view(),
        name="authn-phone-verify-code",
    ),
    path("logout/", views.LogoutView.as_view(), name="authn-logout"),
    path("refresh/", views.RefreshView.as_view(), name="authn-refresh"),
    path("profile/", views.ProfileView.as_view(), name="authn-profile"),
    path("account-emails/", views.AccountEmailsView.as_view(), name="authn-account-emails"),
    path("contact-phones/", views.ContactPhonesView.as_view(), name="authn-contact-phones"),
    path(
        "password-reset/request-code/",
        views.PasswordResetRequestView.as_view(),
        name="authn-password-reset-request",
    ),
    path(
        "password-reset/verify-code/",
        views.PasswordResetConfirmView.as_view(),
        name="authn-password-reset-verify",
    ),
    path(
        "password-reset/confirm/",
        views.PasswordResetConfirmView.as_view(),
        name="authn-password-reset-confirm",
    ),
    path("change-password/", views.ChangePasswordView.as_view(), name="authn-change-password"),
    path("delete-account/", views.DeleteAccountView.as_view(), name="authn-delete-account"),
]
