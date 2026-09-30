"""End-to-end coverage of the single full-access admin role."""

from unittest.mock import patch

from django.contrib import admin
from django.contrib.auth.models import Permission
from django.test import TestCase
from django.urls import reverse

from apps.core.tests.helpers import make_admin, make_member, make_superuser
from apps.mail.models import EmailProviderConfig
from apps.scheduling.models import Event, ParticipantGroup

CORE_URL = "/admin/core/awscredentialconfig/"
AUTHN_URL = "/admin/authn/member/"


class AdminAccessIntegrationTest(TestCase):
    def test_staff_with_legacy_grant_sees_other_apps(self):
        user = make_admin(apps=["core"], email="core-admin@example.com")
        self.client.force_login(user)
        self.assertEqual(self.client.get(CORE_URL).status_code, 200)
        self.assertEqual(self.client.get(AUTHN_URL).status_code, 200)

    def test_staff_without_grants_can_load_index_and_models(self):
        user = make_admin(apps=[], email="empty-admin@example.com")
        self.client.force_login(user)
        self.assertEqual(self.client.get("/admin/").status_code, 200)
        self.assertEqual(self.client.get(CORE_URL).status_code, 200)
        self.assertEqual(self.client.get(AUTHN_URL).status_code, 200)

    def test_read_only_model_renders_branded_403_with_generic_reason(self):
        # Django's own admin gate raises a bare PermissionDenied, so the page
        # falls back to a generic sentence instead of an empty paragraph.
        user = make_admin(apps=[], email="empty-admin@example.com")
        self.client.force_login(user)
        response = self.client.get(reverse("admin:token_blacklist_outstandingtoken_add"))
        self.assertEqual(response.status_code, 403)
        self.assertTemplateUsed(response, "403.html")
        self.assertContains(response, "Permission denied", status_code=403)
        self.assertContains(
            response, "You do not have permission to perform this action.", status_code=403
        )
        self.assertContains(response, 'href="/admin/"', status_code=403)

    def test_superuser_sees_everything(self):
        user = make_superuser(email="master@example.com")
        self.client.force_login(user)
        self.assertEqual(self.client.get(CORE_URL).status_code, 200)
        self.assertEqual(self.client.get(AUTHN_URL).status_code, 200)

    def test_ordinary_and_inactive_members_cannot_open_admin(self):
        users = (
            make_member(email="ordinary@example.com", admin_apps=["core", "authn"]),
            make_admin(email="inactive@example.com", is_active=False),
        )
        for user in users:
            self.client.force_login(user)
            for url in ("/admin/", CORE_URL, AUTHN_URL):
                with self.subTest(user=user.pk, url=url):
                    response = self.client.get(url)
                    self.assertEqual(response.status_code, 302)
                    self.assertIn("/admin/login/", response["Location"])


class RegisteredAdminAccessIntegrationTest(TestCase):
    def test_admins_with_empty_or_narrow_legacy_grants_open_every_model(self):
        for index, grants in enumerate(([], ["authn"])):
            user = make_admin(apps=grants, email=f"admin-{index}@example.com")
            self.client.force_login(user)
            for model in admin.site._registry:
                opts = model._meta
                with self.subTest(grants=grants, model=opts.label_lower):
                    response = self.client.get(
                        reverse(f"admin:{opts.app_label}_{opts.model_name}_changelist"),
                        follow=True,
                    )
                    self.assertEqual(response.status_code, 200)

    def test_superuser_opens_every_registered_model_page_without_app_grants(self):
        self.client.force_login(make_superuser())
        for model in admin.site._registry:
            opts = model._meta
            with self.subTest(model=opts.label_lower):
                response = self.client.get(
                    reverse(f"admin:{opts.app_label}_{opts.model_name}_changelist"),
                    follow=True,
                )
                self.assertEqual(response.status_code, 200)

    def test_admin_without_app_grants_can_open_scheduling_and_mail_add_pages(self):
        self.client.force_login(make_admin(apps=[]))
        for app_label in ("scheduling", "mail"):
            for model in admin.site._registry:
                opts = model._meta
                if opts.app_label != app_label:
                    continue
                with self.subTest(model=opts.label_lower):
                    response = self.client.get(
                        reverse(f"admin:{opts.app_label}_{opts.model_name}_add")
                    )
                    self.assertEqual(response.status_code, 200)

    def test_legacy_model_permissions_do_not_grant_nonstaff_admin_access(self):
        user = make_member(admin_apps=["scheduling", "mail"])
        user.user_permissions.set(
            Permission.objects.filter(content_type__app_label__in=["scheduling", "mail"])
        )
        self.client.force_login(user)
        for model in admin.site._registry:
            opts = model._meta
            if opts.app_label not in ("scheduling", "mail"):
                continue
            for action in ("changelist", "add"):
                with self.subTest(model=opts.label_lower, action=action):
                    url = reverse(f"admin:{opts.app_label}_{opts.model_name}_{action}")
                    response = self.client.get(url)
                    self.assertEqual(response.status_code, 302)
                    self.assertIn("/admin/login/", response["Location"])


class AdminActionsIntegrationTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.scheduler = make_admin(apps=[], email="scheduler@example.com")
        cls.mail_admin = make_admin(apps=["authn"], email="mail-admin@example.com")
        cls.event = Event.objects.create(
            code="ADMIN-ACCESS", name="Admin access test", organizer=cls.scheduler
        )
        cls.provider = EmailProviderConfig.objects.create(
            name="Test provider", from_email="sender@example.com"
        )

    def test_scheduling_admin_can_create_edit_and_delete_a_group(self):
        self.client.force_login(self.scheduler)
        response = self.client.post(
            reverse("admin:scheduling_participantgroup_add"),
            {"event": self.event.pk, "name": "New group", "_save": "Save"},
        )
        self.assertEqual(response.status_code, 302)
        group = ParticipantGroup.objects.get(event=self.event, name="New group")
        change_url = reverse("admin:scheduling_participantgroup_change", args=[group.pk])
        self.assertEqual(self.client.get(change_url).status_code, 200)
        response = self.client.post(
            change_url, {"event": self.event.pk, "name": "Updated group", "_save": "Save"}
        )
        self.assertEqual(response.status_code, 302)
        group.refresh_from_db()
        self.assertEqual(group.name, "Updated group")
        delete_url = reverse("admin:scheduling_participantgroup_delete", args=[group.pk])
        self.assertEqual(self.client.get(delete_url).status_code, 200)
        self.assertEqual(self.client.post(delete_url, {"post": "yes"}).status_code, 302)
        self.assertFalse(ParticipantGroup.objects.filter(pk=group.pk).exists())

    def test_admin_with_unrelated_legacy_grant_can_modify_and_delete_scheduling_records(self):
        group = ParticipantGroup.objects.create(event=self.event, name="Existing group")
        self.client.force_login(self.mail_admin)
        change_url = reverse("admin:scheduling_participantgroup_change", args=[group.pk])
        delete_url = reverse("admin:scheduling_participantgroup_delete", args=[group.pk])
        self.assertEqual(self.client.get(change_url).status_code, 200)
        self.assertEqual(
            self.client.post(
                change_url, {"event": self.event.pk, "name": "Changed", "_save": "Save"}
            ).status_code,
            302,
        )
        group.refresh_from_db()
        self.assertEqual(group.name, "Changed")
        self.assertEqual(self.client.post(delete_url, {"post": "yes"}).status_code, 302)
        self.assertFalse(ParticipantGroup.objects.filter(pk=group.pk).exists())

    def test_ordinary_member_cannot_modify_or_delete_scheduling_records(self):
        group = ParticipantGroup.objects.create(event=self.event, name="Protected group")
        user = make_member(email="ordinary@example.com", admin_apps=["scheduling"])
        self.client.force_login(user)
        for action, data in (
            ("change", {"event": self.event.pk, "name": "Changed", "_save": "Save"}),
            ("delete", {"post": "yes"}),
        ):
            with self.subTest(action=action):
                url = reverse(f"admin:scheduling_participantgroup_{action}", args=[group.pk])
                response = self.client.post(url, data)
                self.assertEqual(response.status_code, 302)
                self.assertIn("/admin/login/", response["Location"])
        group.refresh_from_db()
        self.assertEqual(group.name, "Protected group")

    @patch("apps.mail.admin.send_email_message")
    def test_mail_admin_can_open_and_submit_test_email_action(self, send_email):
        self.client.force_login(self.mail_admin)
        url = "/admin/mail/emailproviderconfig/send-test-email/"
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(
            self.client.post(url, {"recipient": "recipient@example.com"}).status_code, 302
        )
        send_email.assert_called_once()
        self.assertEqual(send_email.call_args.kwargs["recipients"], ["recipient@example.com"])
        self.provider.refresh_from_db()
        self.assertIsNotNone(self.provider.last_tested_at)

    @patch("apps.mail.admin.send_email_message")
    def test_test_email_action_rejects_inactive_and_demoted_admins(self, send_email):
        url = "/admin/mail/emailproviderconfig/send-test-email/"
        self.scheduler.is_active = False
        self.scheduler.save(update_fields=["is_active"])
        self.mail_admin.is_staff = False
        self.mail_admin.save(update_fields=["is_staff"])
        for user in (self.scheduler, self.mail_admin):
            self.client.force_login(user)
            with self.subTest(user=user.pk):
                for response in (
                    self.client.get(url),
                    self.client.post(url, {"recipient": "recipient@example.com"}),
                ):
                    self.assertEqual(response.status_code, 302)
                    self.assertIn("/admin/login/", response["Location"])
        send_email.assert_not_called()
        self.provider.refresh_from_db()
        self.assertIsNone(self.provider.last_tested_at)
