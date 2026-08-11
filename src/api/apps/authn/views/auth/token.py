"""
Public token refresh view that allows unauthenticated access.

The default TokenRefreshView inherits the global IsAuthenticated permission,
which prevents expired-access-token holders from refreshing. This subclass
explicitly sets AllowAny so the refresh endpoint remains accessible.
"""

from rest_framework.permissions import AllowAny
from rest_framework_simplejwt.views import TokenRefreshView


class PublicTokenRefreshView(TokenRefreshView):
    permission_classes = [AllowAny]
