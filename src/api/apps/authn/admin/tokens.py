"""Give administrators access to JWT admin pages while retaining token safeguards."""

from django.contrib import admin
from rest_framework_simplejwt.token_blacklist.admin import (
    BlacklistedTokenAdmin as SimpleJWTBlacklistedTokenAdmin,
)
from rest_framework_simplejwt.token_blacklist.admin import (
    OutstandingTokenAdmin as SimpleJWTOutstandingTokenAdmin,
)
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from unfold.admin import ModelAdmin

from apps.core.admin import AppAccessPermissionMixin

admin.site.unregister(OutstandingToken)
admin.site.unregister(BlacklistedToken)


@admin.register(OutstandingToken)
class OutstandingTokenAdmin(SimpleJWTOutstandingTokenAdmin, AppAccessPermissionMixin, ModelAdmin):
    # Keep Simple JWT's read-only overrides ahead of the administrator permission
    # defaults, including its GET/HEAD-only change permission.
    pass


@admin.register(BlacklistedToken)
class BlacklistedTokenAdmin(SimpleJWTBlacklistedTokenAdmin, AppAccessPermissionMixin, ModelAdmin):
    pass
