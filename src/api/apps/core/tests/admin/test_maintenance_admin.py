from django.test import TestCase
from django.urls import reverse

from apps.core.admin.registrations.maintenance import SiteMaintenanceControlAdminForm
from apps.core.models import SiteMaintenanceControl
from apps.core.tests.helpers import make_superuser


class SiteMaintenanceControlAdminFormTests(TestCase):
    def test_password_field_is_not_prefilled(self):
        config = SiteMaintenanceControl.objects.create(
            is_maintenance=True, bypass_password="secret123"
        )

        form = SiteMaintenanceControlAdminForm(instance=config)

        self.assertEqual(form.fields["bypass_password"].initial, "")
        self.assertFalse(form.fields["bypass_password"].widget.render_value)
        self.assertIn("rounded-default", form.fields["bypass_password"].widget.attrs["class"])
        self.assertEqual(
            form.fields["bypass_password"].widget.template_name,
            "admin/material_password_widget.html",
        )

    def test_blank_password_keeps_existing_hash_without_clear_flag(self):
        config = SiteMaintenanceControl.objects.create(
            is_maintenance=True, bypass_password="secret123"
        )
        original_hash = config.bypass_password

        form = SiteMaintenanceControlAdminForm(
            data={
                "is_maintenance": True,
                "message": config.message,
                "bypass_password": "",
                "clear_bypass_password": False,
            },
            instance=config,
        )

        self.assertTrue(form.is_valid())
        updated = form.save()
        self.assertEqual(updated.bypass_password, original_hash)

    def test_clear_flag_removes_existing_bypass_password(self):
        config = SiteMaintenanceControl.objects.create(
            is_maintenance=True, bypass_password="secret123"
        )

        form = SiteMaintenanceControlAdminForm(
            data={
                "is_maintenance": True,
                "message": config.message,
                "bypass_password": "",
                "clear_bypass_password": True,
            },
            instance=config,
        )

        self.assertTrue(form.is_valid())
        updated = form.save()
        self.assertEqual(updated.bypass_password, "")


class SiteMaintenanceControlAdminViewTests(TestCase):
    def setUp(self):
        self.admin_user = make_superuser()
        self.client.force_login(self.admin_user)

    def test_changelist_redirects_to_existing_singleton_change_form(self):
        config = SiteMaintenanceControl.objects.create(is_maintenance=False)

        response = self.client.get(reverse("admin:core_sitemaintenancecontrol_changelist"))

        self.assertRedirects(
            response,
            reverse("admin:core_sitemaintenancecontrol_change", args=(config.pk,)),
            fetch_redirect_response=False,
        )

    def test_changelist_redirects_to_add_form_when_singleton_is_missing(self):
        response = self.client.get(reverse("admin:core_sitemaintenancecontrol_changelist"))

        self.assertRedirects(
            response,
            reverse("admin:core_sitemaintenancecontrol_add"),
            fetch_redirect_response=False,
        )
