"""Privilege-escalation regression tests for the ContactPhone normalize URLs.

The two custom admin URLs on ``ContactPhoneAdmin``
(``_normalize_preview_view`` and ``_normalize_apply_view``) are registered via
``self.admin_site.admin_view(...)``, which Django gates only on
``is_staff``/``is_active`` — the per-app access model
(``apps.core.utils.access.user_can_access_app`` via ``BaseModelAdmin``) is NOT run.

The preview view exposes member phone PII and the apply view mutates phone
records, so both re-check authn-app access at entry and raise ``PermissionDenied``
(rendered as HTTP 403 under the test client). A staff member whose ``admin_apps``
lacks ``authn`` must get 403; an authn-granted staff member (or superuser) must be
allowed (not 403).
"""

from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse

from apps.authn.models import Member


def _staff(admin_apps=None, **kwargs):
    member = Member.objects.create_user(password="StrongPass123!", is_staff=True, is_active=True, **kwargs)
    if admin_apps is not None:
        member.admin_apps = admin_apps
        member.save(update_fields=["admin_apps"])
    return member


class ContactPhoneNormalizePerAppAccessTest(TestCase):
    def setUp(self):
        cache.clear()
        self.outsider = _staff(admin_apps=["event"], first_name="Out", last_name="Sider")
        self.authn_admin = _staff(admin_apps=["authn"], first_name="Authn", last_name="Admin")
        self.superuser = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Super", last_name="User", is_active=True
        )
        self.preview_url = reverse("admin:authn_contactphone_normalize_preview")
        self.apply_url = reverse("admin:authn_contactphone_normalize_apply")

    def tearDown(self):
        cache.clear()

    # ----- _normalize_preview_view -----

    def test_preview_denied_for_non_authn_staff(self):
        self.client.force_login(self.outsider)
        self.assertEqual(self.client.get(self.preview_url).status_code, 403)

    def test_preview_allowed_for_authn_staff(self):
        self.client.force_login(self.authn_admin)
        self.assertEqual(self.client.get(self.preview_url).status_code, 200)

    def test_preview_allowed_for_superuser(self):
        self.client.force_login(self.superuser)
        self.assertEqual(self.client.get(self.preview_url).status_code, 200)

    # ----- _normalize_apply_view -----

    def test_apply_denied_for_non_authn_staff(self):
        self.client.force_login(self.outsider)
        # Guard runs before the POST/GET branch, for both methods.
        self.assertEqual(self.client.post(self.apply_url, {}).status_code, 403)
        self.assertEqual(self.client.get(self.apply_url).status_code, 403)

    def test_apply_allowed_for_authn_staff(self):
        self.client.force_login(self.authn_admin)
        # A GET past the guard redirects back to the preview view (302), not 403.
        resp = self.client.get(self.apply_url)
        self.assertNotEqual(resp.status_code, 403)
        self.assertEqual(resp.status_code, 302)
