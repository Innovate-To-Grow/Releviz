"""Shared Django settings."""

import os
from datetime import timedelta
from pathlib import Path

from django.templatetags.static import static

from apps.core.access import user_can_access_app
from apps.core.error_tracking import initialize_error_tracking

BASE_DIR = Path(__file__).resolve().parents[2]

SECRET_KEY = "django-insecure-releviz-local-change-me"
DEBUG = False
ALLOWED_HOSTS: list[str] = []

INSTALLED_APPS = [
    "unfold.apps.BasicAppConfig",
    "unfold.contrib.filters",
    "unfold.contrib.forms",
    "apps.authn.apps.AuthnConfig",
    "apps.core.apps.RelevizAdminConfig",
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
    "apps.core.middleware.RequestObservabilityMiddleware",
    "apps.core.middleware.AlbHealthCheckHostMiddleware",
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
        "apps.authn.authentication.SessionJWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=10),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "member_uuid",
    "ALGORITHM": "HS256",
    "AUDIENCE": "releviz-api",
    "ISSUER": "releviz-backend",
    "JTI_CLAIM": "jti",
    "CHECK_REVOKE_TOKEN": True,
}

AUTH_REFRESH_COOKIE_NAME = "releviz_refresh"
AUTH_REFRESH_COOKIE_PATH = "/authn/"
AUTH_REFRESH_COOKIE_SECURE = False
AUTH_REFRESH_COOKIE_SAMESITE = "Lax"
ENABLE_LEGACY_API_PREFIX = False
AUTH_REFRESH_RETRY_GRACE = timedelta(seconds=30)
AUTH_SESSION_ABSOLUTE_LIFETIME = timedelta(days=30)
AUTH_SESSION_RECORD_RETENTION = timedelta(days=30)
AUTH_CHALLENGE_DELIVERY_LIFETIME = timedelta(hours=1)
AUTH_CHALLENGE_VERIFICATION_LIFETIME = timedelta(minutes=10)
AUTH_RATE_LIMIT_BUCKET_RETENTION = timedelta(days=7)
AUTH_TRUSTED_PROXY_COUNT = 0
AUTH_TRUSTED_PROXY_CIDRS = []
AUTH_TRUSTED_PROXY_CIDR_HOPS = 0
AUTH_RATE_LIMITS = {
    "register": {
        "ip": {"limit": 10, "window": 3600, "block": 3600},
        "identity": {"limit": 5, "window": 3600, "block": 3600},
    },
    "code_request": {
        "ip": {"limit": 20, "window": 3600, "block": 3600},
        "identity": {"limit": 5, "window": 3600, "block": 3600},
    },
    "code_verify": {
        "ip": {"limit": 30, "window": 600, "block": 900},
        "identity": {"limit": 10, "window": 600, "block": 900},
    },
    "password_login": {
        "ip": {"limit": 30, "window": 300, "block": 900},
        "identity": {"limit": 15, "window": 900, "block": 900},
    },
    "refresh": {
        "ip": {"limit": 120, "window": 60, "block": 300},
    },
    "admin_login": {
        "ip": {"limit": 20, "window": 300, "block": 900},
        "identity": {"limit": 10, "window": 900, "block": 900},
    },
    "invitation_request": {
        "ip": {"limit": 60, "window": 3600, "block": 3600},
        "identity": {"limit": 20, "window": 3600, "block": 3600},
    },
    "invitation_recipient": {
        "ip": {"limit": 1000, "window": 86400, "block": 3600},
        "identity": {"limit": 500, "window": 86400, "block": 3600},
    },
    "reminder_request": {
        "ip": {"limit": 30, "window": 3600, "block": 3600},
        "identity": {"limit": 10, "window": 3600, "block": 3600},
    },
    "reminder_recipient": {
        "ip": {"limit": 1000, "window": 86400, "block": 3600},
        "identity": {"limit": 500, "window": 86400, "block": 3600},
    },
    "feedback": {
        "ip": {"limit": 20, "window": 3600, "block": 3600},
        "identity": {"limit": 20, "window": 3600, "block": 3600},
    },
}
AUTH_FAILURE_LIMITS = {
    "password_login": {
        "pair": {"limit": 5, "window": 900, "block": 900},
        "identity": {"limit": 20, "window": 3600, "block": 1800},
    }
}
INVITATION_MAX_BATCH_SIZE = 100
INVITATION_MAX_EVENT_RECIPIENTS = 500
REMINDER_MAX_RECIPIENTS = 500

REQUIRE_ENCRYPTED_PASSWORDS = False
FRONTEND_URL = ""
BACKEND_URL = ""
CORS_ALLOW_CREDENTIALS = True
DATA_UPLOAD_MAX_NUMBER_FIELDS = 100000
FIELD_ENCRYPTION_KEY = os.environ.get("DJANGO_FIELD_ENCRYPTION_KEY", "")
USE_SES_EMAIL_PROVIDER = False
DEFAULT_FROM_EMAIL = "noreply@releviz.local"
METRICS_BEARER_TOKEN = os.environ.get("METRICS_BEARER_TOKEN", "").strip()
FEEDBACK_SUBMISSION_RETENTION = timedelta(days=730)

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {
        "request_context": {
            "()": "apps.core.logging.RequestContextFilter",
        }
    },
    "formatters": {
        "json": {
            "()": "apps.core.logging.JsonFormatter",
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "filters": ["request_context"],
            "formatter": "json",
        }
    },
    "root": {
        "handlers": ["console"],
        "level": os.environ.get("APP_LOG_LEVEL", "INFO"),
    },
}

SENTRY_ENABLED = initialize_error_tracking(
    dsn=os.environ.get("SENTRY_DSN", "").strip(),
    environment=os.environ.get("SENTRY_ENVIRONMENT", "").strip(),
    release=os.environ.get("SENTRY_RELEASE", "").strip(),
    traces_sample_rate=os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.05").strip(),
)


def _can(app_label):
    """Sidebar visibility callback mirroring the reference admin."""
    return lambda request: user_can_access_app(request.user, app_label)


def _can_any(*app_labels):
    """Show a sidebar section when any listed Django app is available."""
    return lambda request: any(user_can_access_app(request.user, label) for label in app_labels)


UNFOLD = {
    "SITE_TITLE": "Releviz Admin",
    "SITE_HEADER": "Releviz",
    "SITE_ICON": lambda request: static("images/releviz-mark.png"),
    "SITE_LOGO": lambda request: static("images/releviz-mark.png"),
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
                        "active_paths": [
                            "/admin/authn/contactemail/",
                            "/admin/authn/contactphone/",
                        ],
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
