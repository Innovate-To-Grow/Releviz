"""
URL configuration for authn app.
"""

from django.urls import path

from .views import (
    AcceptInvitationView,
    AccountEmailsView,
    ChangePasswordCodeConfirmView,
    ChangePasswordCodeRequestView,
    ChangePasswordCodeVerifyView,
    ChangePasswordView,
    ContactEmailDetailView,
    ContactEmailListCreateView,
    ContactEmailMakePrimaryView,
    ContactEmailRequestVerificationView,
    ContactEmailVerifyCodeView,
    ContactPhoneDetailView,
    ContactPhoneListCreateView,
    ContactPhoneRequestVerificationView,
    ContactPhoneVerifyCodeView,
    DeleteAccountCodeConfirmView,
    DeleteAccountCodeRequestView,
    DeleteAccountCodeVerifyView,
    EmailAuthRequestCodeView,
    EmailAuthVerifyCodeView,
    ImpersonateLoginView,
    LoginCodeRequestView,
    LoginCodeVerifyView,
    LoginView,
    LogoutView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    PasswordResetVerifyView,
    PhoneAuthRequestCodeView,
    PhoneAuthVerifyCodeView,
    ProfileView,
    PublicKeyView,
    PublicTokenRefreshView,
    RegisterResendCodeView,
    RegisterVerifyCodeView,
    RegisterView,
    SessionView,
    SubscribeView,
    UnsubscribeAutoLoginView,
)

app_name = "authn"

urlpatterns = [
    # Public key for RSA encryption
    path("public-key/", PublicKeyView.as_view(), name="public-key"),
    # Unified email auth
    path("email-auth/request-code/", EmailAuthRequestCodeView.as_view(), name="email-auth-request-code"),
    path("email-auth/verify-code/", EmailAuthVerifyCodeView.as_view(), name="email-auth-verify-code"),
    # Unified phone auth (passwordless SMS code)
    path("phone-auth/request-code/", PhoneAuthRequestCodeView.as_view(), name="phone-auth-request-code"),
    path("phone-auth/verify-code/", PhoneAuthVerifyCodeView.as_view(), name="phone-auth-verify-code"),
    # Registration
    path("register/", RegisterView.as_view(), name="register"),
    path("register/verify-code/", RegisterVerifyCodeView.as_view(), name="register-verify-code"),
    path("register/resend-code/", RegisterResendCodeView.as_view(), name="register-resend-code"),
    # Login
    path("login/", LoginView.as_view(), name="login"),
    path("login/request-code/", LoginCodeRequestView.as_view(), name="login-request-code"),
    path("login/verify-code/", LoginCodeVerifyView.as_view(), name="login-verify-code"),
    # Logout (blacklists refresh token)
    path("logout/", LogoutView.as_view(), name="logout"),
    # Token refresh
    path("refresh/", PublicTokenRefreshView.as_view(), name="token-refresh"),
    # Authenticated frontend session bootstrap
    path("session/", SessionView.as_view(), name="session"),
    # Password reset
    path("password-reset/request-code/", PasswordResetRequestView.as_view(), name="password-reset-request-code"),
    path("password-reset/verify-code/", PasswordResetVerifyView.as_view(), name="password-reset-verify-code"),
    path("password-reset/confirm/", PasswordResetConfirmView.as_view(), name="password-reset-confirm"),
    # Profile
    path("profile/", ProfileView.as_view(), name="profile"),
    path("account-emails/", AccountEmailsView.as_view(), name="account-emails"),
    # Change password
    path("change-password/", ChangePasswordView.as_view(), name="change-password"),
    path("change-password/request-code/", ChangePasswordCodeRequestView.as_view(), name="change-password-request-code"),
    path("change-password/verify-code/", ChangePasswordCodeVerifyView.as_view(), name="change-password-verify-code"),
    path("change-password/confirm/", ChangePasswordCodeConfirmView.as_view(), name="change-password-confirm"),
    path("delete-account/request-code/", DeleteAccountCodeRequestView.as_view(), name="delete-account-request-code"),
    path("delete-account/verify-code/", DeleteAccountCodeVerifyView.as_view(), name="delete-account-verify-code"),
    path("delete-account/confirm/", DeleteAccountCodeConfirmView.as_view(), name="delete-account-confirm"),
    # Contact Emails (authenticated)
    path("contact-emails/", ContactEmailListCreateView.as_view(), name="contact-email-list-create"),
    path("contact-emails/<uuid:pk>/", ContactEmailDetailView.as_view(), name="contact-email-detail"),
    path(
        "contact-emails/<uuid:pk>/request-verification/",
        ContactEmailRequestVerificationView.as_view(),
        name="contact-email-request-verification",
    ),
    path(
        "contact-emails/<uuid:pk>/verify-code/",
        ContactEmailVerifyCodeView.as_view(),
        name="contact-email-verify-code",
    ),
    path(
        "contact-emails/<uuid:pk>/make-primary/",
        ContactEmailMakePrimaryView.as_view(),
        name="contact-email-make-primary",
    ),
    # Contact Phones (authenticated)
    path("contact-phones/", ContactPhoneListCreateView.as_view(), name="contact-phone-list-create"),
    path("contact-phones/<uuid:pk>/", ContactPhoneDetailView.as_view(), name="contact-phone-detail"),
    path(
        "contact-phones/<uuid:pk>/request-verification/",
        ContactPhoneRequestVerificationView.as_view(),
        name="contact-phone-request-verification",
    ),
    path(
        "contact-phones/<uuid:pk>/verify-code/",
        ContactPhoneVerifyCodeView.as_view(),
        name="contact-phone-verify-code",
    ),
    # Admin invitation acceptance (public)
    path("invite/<str:token>/", AcceptInvitationView.as_view(), name="accept-invitation"),
    # Subscribe (public)
    path("subscribe/", SubscribeView.as_view(), name="subscribe"),
    # Unsubscribe auto-login (from email link)
    path("unsubscribe-login/", UnsubscribeAutoLoginView.as_view(), name="unsubscribe-login"),
    # Admin impersonation login
    path("impersonate-login/", ImpersonateLoginView.as_view(), name="impersonate-login"),
]
