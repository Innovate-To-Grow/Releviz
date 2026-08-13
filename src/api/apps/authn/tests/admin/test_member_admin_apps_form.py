"""Tests for the ``admin_apps`` field on the Member admin change form.

The foundation replaced the per-model ``user_permissions`` widget with a
multi-select of registered admin app labels backed by ``Member.admin_apps``
(see apps.authn.admin.members.forms.MemberChangeForm and apps.core.utils.access).
These tests assert the change form renders the new control, exposes the
registered app labels as choices, persists a submitted selection, and no
longer exposes ``user_permissions``.

The admin restricts the form's editable fields to those in ``MemberAdmin``'s
fieldsets (``admin_apps`` is in; ``user_permissions`` is out), so assertions go
through the admin-bound form (``MemberAdmin.get_form``) and the real change
page rather than the raw ``__all__`` form class.
"""

from html.parser import HTMLParser

from django import forms
from django.contrib import admin
from django.core.cache import cache
from django.test import RequestFactory, TestCase, override_settings

from apps.authn.admin.members.forms import admin_app_choices
from apps.authn.models import ContactEmail, Member


def _admin_change_form(obj):
    """Return the admin-bound change form class for ``obj`` (restricted by fieldsets)."""
    model_admin = admin.site._registry[Member]
    request = RequestFactory().get("/")
    request.user = Member(is_superuser=True, is_staff=True, is_active=True)
    return model_admin.get_form(request, obj=obj, change=True)


class MemberChangeFormFieldTests(TestCase):
    """Assertions on the admin-bound change form (the surface operators see)."""

    def setUp(self):
        self.member = Member.objects.create_user(
            password="StrongPass123!", first_name="Form", last_name="Field", is_staff=True
        )

    def test_admin_apps_is_a_multi_select(self):
        form = _admin_change_form(self.member)()
        field = form.fields["admin_apps"]
        self.assertIsInstance(field, forms.MultipleChoiceField)
        self.assertIsInstance(field.widget, forms.CheckboxSelectMultiple)
        self.assertFalse(field.required)

    def test_user_permissions_is_not_a_form_field(self):
        form = _admin_change_form(self.member)()
        self.assertNotIn("user_permissions", form.fields)

    def test_admin_apps_choices_include_registered_admin_apps(self):
        form = _admin_change_form(self.member)()
        labels = {value for value, _label in form.fields["admin_apps"].choices}
        for expected in ("cms", "event", "authn"):
            self.assertIn(expected, labels)

    def test_admin_app_choices_helper_matches_registry(self):
        labels = {value for value, _label in admin_app_choices()}
        registry_labels = {model._meta.app_label for model in admin.site._registry}
        self.assertEqual(labels, registry_labels)

    def test_admin_app_choice_labels_include_label_in_parens(self):
        choices = dict(admin_app_choices())
        # Rendered as "<verbose name> (<label>)" for operator clarity.
        self.assertIn("(authn)", choices["authn"])

    def test_admin_bound_form_persists_admin_apps(self):
        FormClass = _admin_change_form(self.member)
        form = FormClass(
            data={
                "first_name": "Form",
                "last_name": "Field",
                "is_active": "on",
                "is_staff": "on",
                "admin_apps": ["cms", "event"],
            },
            instance=self.member,
        )
        self.assertTrue(form.is_valid(), form.errors)
        saved = form.save()
        saved.refresh_from_db()
        self.assertEqual(sorted(saved.admin_apps), ["cms", "event"])

    def test_admin_bound_form_rejects_unregistered_app_label(self):
        FormClass = _admin_change_form(self.member)
        form = FormClass(
            data={
                "first_name": "Form",
                "last_name": "Field",
                "is_active": "on",
                "is_staff": "on",
                "admin_apps": ["not_a_real_app"],
            },
            instance=self.member,
        )
        self.assertFalse(form.is_valid())
        self.assertIn("admin_apps", form.errors)


@override_settings(ROOT_URLCONF="config.routing.urls", ADMIN_REQUIRE_CONFIRMATION=False)
class MemberAdminChangePageTests(TestCase):
    """Exercise the real admin change page through the test client.

    ``ADMIN_REQUIRE_CONFIRMATION=False`` skips the confirm-on-save interstitial
    so the POST commits directly (matching the inline-submit test class), letting
    us assert persistence of the submitted ``admin_apps`` selection.
    """

    def setUp(self):
        cache.clear()
        self.superuser = Member.objects.create_superuser(
            password="StrongPass123!",
            first_name="Super",
            last_name="User",
            is_staff=True,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.superuser,
            email_address="super@example.com",
            email_type="primary",
            verified=True,
        )
        self.target = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Target",
            last_name="User",
            is_staff=True,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.target,
            email_address="target@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_login(self.superuser)

    def tearDown(self):
        cache.clear()

    def _change_url(self):
        return f"/admin/authn/member/{self.target.pk}/change/"

    def test_change_page_renders_admin_apps_multiselect(self):
        resp = self.client.get(self._change_url())
        self.assertEqual(resp.status_code, 200)
        content = resp.content.decode()
        # Rendered as named checkbox inputs whose values are app labels.
        self.assertIn('name="admin_apps"', content)
        self.assertIn('value="cms"', content)
        self.assertIn('value="event"', content)

    def test_change_page_omits_user_permissions(self):
        resp = self.client.get(self._change_url())
        self.assertEqual(resp.status_code, 200)
        content = resp.content.decode()
        self.assertNotIn('name="user_permissions"', content)
        self.assertNotIn('id="id_user_permissions"', content)

    def test_post_persists_selected_admin_apps(self):
        data = self._build_post_data({"admin_apps": ["cms", "projects"]})
        resp = self.client.post(self._change_url(), data)
        # 302 = a successful save+redirect; a 200 would mean the form re-rendered
        # with errors and never committed, so assert the redirect explicitly.
        self.assertEqual(resp.status_code, 302, resp.content.decode())
        self.target.refresh_from_db()
        self.assertEqual(sorted(self.target.admin_apps), ["cms", "projects"])

    def test_post_clearing_admin_apps_persists_empty_list(self):
        self.target.admin_apps = ["cms"]
        self.target.save(update_fields=["admin_apps"])
        # Omit admin_apps entirely -> the not-required multi-select clears to [].
        data = self._build_post_data()
        data.pop("admin_apps", None)
        resp = self.client.post(self._change_url(), data)
        self.assertEqual(resp.status_code, 302, resp.content.decode())
        self.target.refresh_from_db()
        self.assertEqual(self.target.admin_apps, [])

    def _build_post_data(self, overrides=None):
        """Scrape the change page's form inputs into a POST-ready dict.

        Mirrors the helper in test_member_admin_inlines so the round-trip
        submits a complete, valid Member change form.
        """
        resp = self.client.get(self._change_url())
        self.assertEqual(resp.status_code, 200)

        fields: dict[str, str] = {}
        textarea_name: str | None = None
        select_name: str | None = None
        selected_value: str | None = None

        class _FormParser(HTMLParser):
            def handle_starttag(self, tag, attrs):
                nonlocal textarea_name, select_name, selected_value
                attr = dict(attrs)
                name = attr.get("name")
                if tag == "input" and name:
                    if attr.get("type") == "checkbox":
                        if "checked" in attr:
                            fields[name] = attr.get("value", "on")
                    else:
                        fields.setdefault(name, attr.get("value", ""))
                elif tag == "textarea" and name:
                    textarea_name = name
                elif tag == "select" and name:
                    select_name = name
                elif tag == "option" and select_name and "selected" in attr:
                    selected_value = attr.get("value", "")

            def handle_data(self, data):
                nonlocal textarea_name
                if textarea_name:
                    fields.setdefault(textarea_name, data.strip())

            def handle_endtag(self, tag):
                nonlocal textarea_name, select_name, selected_value
                if tag == "textarea":
                    textarea_name = None
                elif tag == "select" and select_name:
                    if selected_value is not None:
                        fields.setdefault(select_name, selected_value)
                    select_name = None
                    selected_value = None

        parser = _FormParser()
        parser.feed(resp.content.decode())

        # No inline rows for this round-trip.
        for prefix in ("contact_emails",):
            fields.setdefault(f"{prefix}-TOTAL_FORMS", "0")
            fields.setdefault(f"{prefix}-INITIAL_FORMS", "0")
            fields.setdefault(f"{prefix}-MIN_NUM_FORMS", "0")
            fields.setdefault(f"{prefix}-MAX_NUM_FORMS", "1000")

        if overrides:
            fields.update(overrides)

        fields.pop("_addanother", None)
        fields.pop("_continue", None)
        fields["_save"] = "Save"
        return fields
