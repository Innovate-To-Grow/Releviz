"""Regression: confirm-on-save diff labels must be JSON-serializable.

compute_add_diff / compute_change_diff store each changed field's form label in a
diff that ConfirmOnSaveMixin writes into request.session (JSON-serialized). Form
labels are frequently lazy gettext proxies (e.g. AbstractUser's "first name", or
the admin_apps field's _("Admin apps")), which raise
``TypeError: Object of type __proxy__ is not JSON serializable`` at session save —
a 500 on every add/change with ADMIN_REQUIRE_CONFIRMATION on. The labels must be
str()-resolved (as compute_delete_diff already does).
"""

import json

from django import forms
from django.forms import modelform_factory
from django.test import TestCase
from django.utils.translation import gettext_lazy as _

from apps.authn.models import Member
from apps.core.admin.mixins.confirm_on_save_utils import compute_add_diff, compute_change_diff
from apps.event.tests.helpers import make_member


class _LazyLabelForm(forms.Form):
    admin_apps = forms.MultipleChoiceField(label=_("Admin apps"), required=False, choices=[("cms", "cms")])


class ConfirmDiffLazyLabelTest(TestCase):
    def test_add_diff_label_is_plain_str_and_json_serializable(self):
        form = _LazyLabelForm(data={"admin_apps": ["cms"]})
        self.assertTrue(form.is_valid(), form.errors)
        diff = compute_add_diff(form)
        self.assertTrue(diff)
        self.assertTrue(all(type(entry["label"]) is str for entry in diff))
        json.dumps(diff)  # must not raise

    def test_change_diff_label_is_plain_str_and_json_serializable(self):
        member = make_member(email="lazy@example.com", first_name="Old", last_name="Name")
        # first_name's form label comes from AbstractUser's gettext_lazy("first name").
        member_form_cls = modelform_factory(Member, fields=["first_name"])
        form = member_form_cls({"first_name": "New"}, instance=member)
        self.assertTrue(form.is_valid(), form.errors)
        diff = compute_change_diff(Member, member.pk, form)
        self.assertTrue(diff)
        self.assertTrue(all(type(entry["label"]) is str for entry in diff))
        json.dumps(diff)  # must not raise
