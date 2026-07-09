"""Shared Django settings."""

import os
from datetime import timedelta
from pathlib import Path

from django.templatetags.static import static

from apps.core.access import user_can_access_app

BASE_DIR = Path(__file__).resolve().parents[2]

SECRET_KEY = "django-insecure-releviz-local-change-me"
DEBUG = False
ALLOWED_HOSTS: list[str] = []

INSTALLED_APPS = [
    "unfold",
    "unfold.contrib.filters",
    "unfold.contrib.forms",
    "apps.authn.apps.AuthnConfig",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "apps.core.apps.CoreConfig",
    "apps.scheduling.apps.SchedulingConfig",
    "apps.messaging.apps.MessagingConfig",
    "corsheaders",
    "rest_framework",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "apps" / "core" / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    }
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "apps" / "core" / "static"]
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "authn.Member"
AUTHENTICATION_BACKENDS = ["apps.authn.backends.EmailAuthBackend"]

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "60/minute",
        "login": "10/minute",
        "email_code_request": "30/minute",
        "email_code_verify": "60/minute",
    },
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(hours=1),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "member_uuid",
    "ALGORITHM": "HS256",
    "AUDIENCE": "releviz-api",
    "ISSUER": "releviz-backend",
    "JTI_CLAIM": "jti",
}

REQUIRE_ENCRYPTED_PASSWORDS = False
FRONTEND_URL = ""
BACKEND_URL = ""
CORS_ALLOW_CREDENTIALS = True
DATA_UPLOAD_MAX_NUMBER_FIELDS = 100000
FIELD_ENCRYPTION_KEY = os.environ.get("DJANGO_FIELD_ENCRYPTION_KEY", "")
USE_SES_EMAIL_PROVIDER = False
DEFAULT_FROM_EMAIL = "noreply@releviz.local"


def _can(app_label):
    """Sidebar visibility callback mirroring the reference admin."""
    return lambda request: user_can_access_app(request.user, app_label)


def _can_any(*app_labels):
    """Show a sidebar section when any listed Django app is available."""
    return lambda request: any(user_can_access_app(request.user, label) for label in app_labels)


UNFOLD = {
    "SITE_TITLE": "Scheduler Admin",
    "SITE_HEADER": "Scheduler",
    "SITE_ICON": lambda request: static("images/scheduler-logo.svg"),
    "SITE_LOGO": lambda request: static("images/scheduler-logo.svg"),
    "COLORS": {
        "primary": {
            "50": "#f9f9ff",
            "100": "#ebf1ff",
            "200": "#d5e3ff",
            "300": "#a7c8ff",
            "400": "#82adf0",
            "500": "#6792d4",
            "600": "#305f9d",
            "700": "#0f4784",
            "800": "#003061",
            "900": "#001b3c",
            "950": "#001026",
        },
    },
    "STYLES": [
        lambda request: static("admin/css/google-material-admin.css"),
        lambda request: static("admin/css/tabs.css"),
        lambda request: static("admin/css/file-input.css"),
    ],
    "TABS": [
        {
            "models": [
                "scheduling.event",
                "scheduling.participant",
                "scheduling.weight",
                "scheduling.userevent",
                "scheduling.eventinvitation",
            ],
            "items": [
                {"title": "Events", "link": "/admin/scheduling/event/"},
                {"title": "Participants", "link": "/admin/scheduling/participant/"},
                {"title": "Weights", "link": "/admin/scheduling/weight/"},
                {"title": "User Events", "link": "/admin/scheduling/userevent/"},
                {"title": "Invitations", "link": "/admin/scheduling/eventinvitation/"},
            ],
        },
        {
            "models": ["authn.member", "authn.contactemail", "authn.contactphone"],
            "items": [
                {"title": "Members", "link": "/admin/authn/member/"},
                {"title": "Emails", "link": "/admin/authn/contactemail/"},
                {"title": "Phones", "link": "/admin/authn/contactphone/"},
            ],
        },
        {
            "models": ["authn.emailauthchallenge", "authn.rsakeypair", "auth.group"],
            "items": [
                {"title": "Email Challenges", "link": "/admin/authn/emailauthchallenge/"},
                {"title": "RSA Keypairs", "link": "/admin/authn/rsakeypair/"},
                {"title": "Groups", "link": "/admin/auth/group/"},
            ],
        },
        {
            "models": ["messaging.emailproviderconfig", "messaging.emailmessagelog"],
            "items": [
                {"title": "Email Providers", "link": "/admin/messaging/emailproviderconfig/"},
                {"title": "Email Logs", "link": "/admin/messaging/emailmessagelog/"},
            ],
        },
    ],
    "SIDEBAR": {
        "show_search": True,
        "navigation": [
            {
                "title": "Scheduling",
                "permission": _can("scheduling"),
                "items": [
                    {
                        "title": "Events",
                        "link": "/admin/scheduling/event/",
                        "permission": _can("scheduling"),
                    },
                    {
                        "title": "Participants",
                        "link": "/admin/scheduling/participant/",
                        "permission": _can("scheduling"),
                    },
                    {
                        "title": "Weights",
                        "link": "/admin/scheduling/weight/",
                        "permission": _can("scheduling"),
                    },
                    {
                        "title": "Invitations",
                        "link": "/admin/scheduling/eventinvitation/",
                        "permission": _can("scheduling"),
                    },
                ],
            },
            {
                "title": "Email Delivery",
                "permission": _can("messaging"),
                "items": [
                    {
                        "title": "AWS SES Providers",
                        "link": "/admin/messaging/emailproviderconfig/",
                        "permission": _can("messaging"),
                    },
                    {
                        "title": "Email Logs",
                        "link": "/admin/messaging/emailmessagelog/",
                        "permission": _can("messaging"),
                    },
                ],
            },
            {
                "title": "Members & Authentication",
                "permission": _can("authn"),
                "items": [
                    {
                        "title": "Members",
                        "link": "/admin/authn/member/",
                        "permission": _can("authn"),
                    },
                    {
                        "title": "Emails & Phones",
                        "link": "/admin/authn/contactemail/",
                        "permission": _can("authn"),
                    },
                    {
                        "title": "Login Challenges",
                        "link": "/admin/authn/emailauthchallenge/",
                        "permission": _can("authn"),
                    },
                ],
            },
            {
                "title": "Site Settings",
                "permission": _can_any("auth", "admin"),
                "items": [
                    {"title": "Groups", "link": "/admin/auth/group/", "permission": _can("auth")},
                    {
                        "title": "RSA Keypairs",
                        "link": "/admin/authn/rsakeypair/",
                        "permission": _can("authn"),
                    },
                ],
            },
        ],
    },
}
