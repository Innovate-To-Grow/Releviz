"""
Authn app admin configuration.

Registers all authn models with Django admin for user management.
Organized into modules by functionality:
- member: Member and MemberProfile admin
- contact: ContactEmail admin
- security: RSAKeypair admin
"""

from django.contrib import admin
from django.contrib.auth.models import Group


from .members.contact import ContactEmailAdmin
from .members.invitation import AdminInvitationAdmin
from .members.member import MemberAdmin
from .security import RSAKeypairAdmin

admin.site.unregister(Group)

__all__ = [
    # Member
    "MemberAdmin",
    # Contact
    "ContactEmailAdmin",
    # Invitation
    "AdminInvitationAdmin",
    # Security
    "RSAKeypairAdmin",
]
