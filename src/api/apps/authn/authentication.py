from rest_framework_simplejwt.authentication import JWTAuthentication


class SessionJWTAuthentication(JWTAuthentication):
    """Custom JWT authentication class for Releviz.

    Extends SimpleJWT's default JWTAuthentication. Session-based
    validation and access-level checks can be added here as the
    corresponding models and enums are restored.
    """
