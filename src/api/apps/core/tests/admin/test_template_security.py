from types import SimpleNamespace
from unittest.mock import patch

from django.template.loader import render_to_string
from django.templatetags import i18n
from django.test import SimpleTestCase


class AdminTemplateTranslationEscapingTests(SimpleTestCase):
    def test_bulk_action_translation_is_escaped(self):
        original_gettext = i18n.translation.gettext

        def malicious_gettext(message):
            if message.startswith("Select all"):
                return "<script>alert('translated')</script>"
            return original_gettext(message)

        context = {
            "cl": SimpleNamespace(
                model_admin=SimpleNamespace(
                    list_fullwidth=False,
                    list_disable_select_all=False,
                ),
                result_list=[object()],
                result_count=2,
            ),
            "action_form": [],
            "action_index": 0,
            "actions_selection_counter": True,
            "module_name": "objects",
            "selection_note": "1 selected",
            "selection_note_all": "All selected",
        }

        with patch(
            "django.templatetags.i18n.translation.gettext",
            side_effect=malicious_gettext,
        ):
            html = render_to_string("admin/actions.html", context)

        self.assertNotIn("<script>alert('translated')</script>", html)
        self.assertIn("&lt;script&gt;alert(&#x27;translated&#x27;)&lt;/script&gt;", html)

    def test_app_list_title_translation_is_escaped(self):
        original_gettext = i18n.translation.gettext

        def malicious_gettext(message):
            if message.startswith("Models in the"):
                return "<script>alert('translated')</script>"
            return original_gettext(message)

        context = {
            "app_list": [
                {
                    "app_label": "core",
                    "app_url": "/admin/core/",
                    "models": [],
                    "name": "Core",
                }
            ],
            "request": SimpleNamespace(path="/admin/"),
            "show_changelinks": True,
        }

        with patch(
            "django.templatetags.i18n.translation.gettext",
            side_effect=malicious_gettext,
        ):
            html = render_to_string("unfold/helpers/app_list_default.html", context)

        self.assertNotIn("<script>alert('translated')</script>", html)
        self.assertIn(
            'title="&lt;script&gt;alert(&#x27;translated&#x27;)&lt;/script&gt;"',
            html,
        )
