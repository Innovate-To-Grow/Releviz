"""Shared Django settings."""

from datetime import timedelta
from pathlib import Path

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
    "corsheaders",
    "rest_framework",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
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

UNFOLD = {
    "SITE_TITLE": "Releviz Admin",
    "SITE_HEADER": "Releviz",
    "COLORS": {
        "primary": {
            "50": "#f5f8ff",
            "100": "#e8f0ff",
            "200": "#cfe0ff",
            "300": "#9dbfff",
            "400": "#679ee8",
            "500": "#347fc5",
            "600": "#16669f",
            "700": "#07517f",
            "800": "#063d61",
            "900": "#042842",
            "950": "#02172a",
        },
    },
    "SIDEBAR": {
        "show_search": True,
        "navigation": [
            {
                "title": "Accounts",
                "items": [
                    {"title": "Members", "link": "/admin/authn/member/"},
                    {"title": "Emails", "link": "/admin/authn/contactemail/"},
                    {"title": "Phones", "link": "/admin/authn/contactphone/"},
                ],
            },
            {
                "title": "Scheduling",
                "items": [
                    {"title": "Events", "link": "/admin/scheduling/event/"},
                    {"title": "Participants", "link": "/admin/scheduling/participant/"},
                    {"title": "Weights", "link": "/admin/scheduling/weight/"},
                ],
            },
        ],
    },
}
