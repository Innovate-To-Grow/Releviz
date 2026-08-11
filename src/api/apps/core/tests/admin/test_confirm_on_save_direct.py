"""Direct unit tests for ConfirmOnSaveMixin internal branches.

These exercise code paths that are awkward to hit through the full admin HTTP
flow: the autosave/popup skips, file-upload caching + restore, and the many
short-circuit branches inside ``response_action`` / ``_execute_confirmed_action``.
"""

from unittest.mock import MagicMock, patch

from django.contrib import admin
from django.contrib.admin import helpers
from django.contrib.admin.exceptions import DisallowedModelAdminToField
from django.contrib.admin.options import TO_FIELD_VAR
from django.contrib.auth import get_user_model
from django.contrib.messages.storage.fallback import FallbackStorage
from django.contrib.sessions.backends.db import SessionStore
from django.core.cache import cache
from django.core.exceptions import PermissionDenied
from django.core.files.uploadedfile import SimpleUploadedFile
from django.http import HttpResponseRedirect, QueryDict
from django.test import RequestFactory, TestCase, override_settings

from apps.cms.models import CMSAsset, CMSEmbedAllowedHost
from apps.core.admin.mixins.confirm_on_save import CACHE_FILE_PREFIX
from apps.projects.models import Semester

User = get_user_model()


def _wire_request(request):
    request.session = SessionStore()
    request._messages = FallbackStorage(request)
    request.user = MagicMock(is_superuser=True, is_active=True, is_staff=True)
    return request


def _host_admin():
    return admin.site._registry[CMSEmbedAllowedHost]


def _semester_admin():
    return admin.site._registry[Semester]


def _asset_admin():
    return admin.site._registry[CMSAsset]


class ShouldSkipConfirmationTest(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.admin = _host_admin()

    def test_skip_when_require_confirmation_false(self):
        request = _wire_request(self.factory.post("/admin/"))
        with patch.object(type(self.admin), "require_confirmation", False):
            self.assertTrue(self.admin._should_skip_confirmation(request))

    @override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
    def test_skip_on_autosave(self):
        request = _wire_request(self.factory.post("/admin/", {"_autosave": "1"}))
        self.assertTrue(self.admin._should_skip_confirmation(request))

    @override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
    def test_no_skip_for_plain_post(self):
        request = _wire_request(self.factory.post("/admin/", {"x": "1"}))
        self.assertFalse(self.admin._should_skip_confirmation(request))


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ChangeformObjectMissingTest(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.admin = _host_admin()

    def test_confirmed_save_key_routes_to_executor(self):
        request = _wire_request(self.factory.post("/admin/", {"_confirmed_save": "1", "hostname": "z.com"}))
        pending = {"token": "keep-this-token", "file_keys": {}}
        request.session[self.admin._session_key()] = pending
        sentinel = object()
        with patch.object(self.admin, "_execute_confirmed_save", return_value=sentinel) as exec_save:
            result = self.admin.changeform_view(request, object_id=None)
        self.assertIs(result, sentinel)
        exec_save.assert_called_once()
        self.assertEqual(request.session[self.admin._session_key()], pending)

    def test_save_as_new_checks_add_permission_before_constructing_formsets(self):
        request = _wire_request(
            self.factory.post(
                "/admin/",
                {"_saveasnew": "1", "hostname": "copy.com", "is_active": "on"},
            )
        )

        with (
            patch.object(self.admin, "has_add_permission", return_value=False) as has_add,
            patch.object(self.admin, "get_object") as get_object,
            patch.object(self.admin, "_create_formsets") as create_formsets,
            patch.object(self.admin, "get_confirmation_diff") as diff_hook,
        ):
            with self.assertRaises(PermissionDenied):
                self.admin.changeform_view(request, object_id="existing-object")

        has_add.assert_called_once_with(request)
        get_object.assert_not_called()
        create_formsets.assert_not_called()
        diff_hook.assert_not_called()

    def test_change_checks_permission_before_constructing_formsets(self):
        host = CMSEmbedAllowedHost.objects.create(hostname="readonly.com", is_active=True)
        request = _wire_request(
            self.factory.post(
                "/admin/",
                {"hostname": "changed.com", "is_active": "on"},
            )
        )

        with (
            patch.object(self.admin, "has_change_permission", return_value=False) as has_change,
            patch.object(self.admin, "_create_formsets") as create_formsets,
            patch.object(self.admin, "get_confirmation_diff") as diff_hook,
        ):
            with self.assertRaises(PermissionDenied):
                self.admin.changeform_view(request, object_id=str(host.pk))

        has_change.assert_called_once_with(request, host)
        create_formsets.assert_not_called()
        diff_hook.assert_not_called()

    def test_disallowed_to_field_is_rejected_before_object_or_formset_lookup(self):
        request = _wire_request(
            self.factory.post(
                "/admin/",
                {
                    TO_FIELD_VAR: "hostname",
                    "hostname": "changed.com",
                    "is_active": "on",
                },
            )
        )

        with (
            patch.object(self.admin, "to_field_allowed", return_value=False) as allowed,
            patch.object(self.admin, "get_object") as get_object,
            patch.object(self.admin, "_create_formsets") as create_formsets,
            patch.object(self.admin, "get_confirmation_diff") as diff_hook,
        ):
            with self.assertRaises(DisallowedModelAdminToField):
                self.admin.changeform_view(request, object_id="existing-object")

        allowed.assert_called_once_with(request, "hostname")
        get_object.assert_not_called()
        create_formsets.assert_not_called()
        diff_hook.assert_not_called()

    def test_missing_object_defers_to_super(self):
        request = _wire_request(self.factory.post("/admin/", {"hostname": "x.com"}))
        sentinel = object()
        with (
            patch.object(self.admin, "get_object", return_value=None),
            patch(
                "django.contrib.admin.options.ModelAdmin.changeform_view",
                return_value=sentinel,
            ) as super_view,
        ):
            result = self.admin.changeform_view(request, object_id="deadbeef")
        self.assertIs(result, sentinel)
        super_view.assert_called_once()


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ChangeformInlineValidationTest(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.admin = _host_admin()

    def test_confirmation_diff_hook_receives_validated_formsets(self):
        request = _wire_request(
            self.factory.post(
                "/admin/",
                {"hostname": "hook-arguments.com", "is_active": "on"},
            )
        )
        formset = MagicMock()
        formset.is_valid.return_value = True
        custom_diff = [{"field": "inline", "label": "Inline", "new_value": "Included"}]

        with (
            patch.object(self.admin, "_create_formsets", return_value=([formset], [object()])),
            patch.object(self.admin, "get_confirmation_diff", return_value=custom_diff) as diff_hook,
        ):
            response = self.admin.changeform_view(request, object_id=None)

        self.assertIsInstance(response, HttpResponseRedirect)
        formset.is_valid.assert_called_once_with()
        diff_hook.assert_called_once()
        hook_request, hook_obj, hook_form, hook_formsets, hook_action_type = diff_hook.call_args.args
        self.assertIs(hook_request, request)
        self.assertIsNone(hook_obj)
        self.assertTrue(hook_form.is_valid())
        self.assertEqual(hook_formsets, [formset])
        self.assertEqual(hook_action_type, "add")
        self.assertEqual(request.session[self.admin._session_key()]["diff"], custom_diff)

    def test_invalid_inline_formset_returns_normal_change_form_without_confirmation(self):
        request = _wire_request(
            self.factory.post(
                "/admin/",
                {"hostname": "invalid-inline.com", "is_active": "on"},
            )
        )
        invalid_formset = MagicMock()
        invalid_formset.is_valid.return_value = False
        normal_change_form = object()

        with (
            patch.object(self.admin, "_create_formsets", return_value=([invalid_formset], [object()])),
            patch.object(self.admin, "get_confirmation_diff") as diff_hook,
            patch(
                "django.contrib.admin.options.ModelAdmin.changeform_view",
                return_value=normal_change_form,
            ) as super_view,
        ):
            response = self.admin.changeform_view(request, object_id=None)

        self.assertIs(response, normal_change_form)
        invalid_formset.is_valid.assert_called_once_with()
        diff_hook.assert_not_called()
        super_view.assert_called_once()
        self.assertEqual(super_view.call_args.args[:3], (request, None, ""))
        self.assertNotIn(self.admin._session_key(), request.session)


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class FileUploadCachingTest(TestCase):
    """Covers caching uploaded files at confirm time and restoring on execute."""

    def tearDown(self):
        cache.clear()

    def test_add_with_file_caches_upload_and_restores_it(self):
        admin_obj = _asset_admin()
        factory = RequestFactory()

        upload = SimpleUploadedFile("doc.txt", b"hello-bytes", content_type="text/plain")
        request = _wire_request(
            factory.post(
                "/admin/",
                {"title": "My Asset", "asset_type": "image"},
            )
        )
        # Attach the uploaded file to the request.
        request.FILES["file"] = upload

        # Build a valid form result so changeform_view proceeds to caching.
        fake_form = MagicMock()
        fake_form.is_valid.return_value = True
        fake_form.cleaned_data = {"name": "My Asset"}

        with (
            patch.object(admin_obj, "get_form", return_value=lambda *a, **k: fake_form),
            patch(
                "apps.core.admin.mixins.confirm_on_save.compute_add_diff",
                return_value={"title": {"old": "", "new": "My Asset"}},
            ),
            patch(
                "apps.core.admin.mixins.confirm_on_save.serialize_post_data",
                return_value={"title": ["My Asset"]},
            ),
        ):
            response = admin_obj.changeform_view(request, object_id=None)

        # Redirects to the confirm page, and the upload was cached.
        self.assertIsInstance(response, HttpResponseRedirect)
        session_key = admin_obj._session_key()
        pending = request.session[session_key]
        self.assertIn("file", pending["file_keys"])
        cache_key = pending["file_keys"]["file"]
        self.assertTrue(cache_key.startswith(CACHE_FILE_PREFIX))
        cached = cache.get(cache_key)
        self.assertEqual(cached["name"], "doc.txt")
        self.assertEqual(cached["content"], b"hello-bytes")

        # Now drive _do_confirmed_save and ensure the file is restored and cache cleared.
        confirm_request = _wire_request(factory.post("/admin/confirm/"))
        restored = {}

        def capture_super(req, object_id, form_url, extra):
            restored["file"] = req._files.get("file")
            return HttpResponseRedirect("/done/")

        with patch(
            "django.contrib.admin.options.ModelAdmin.changeform_view",
            side_effect=capture_super,
        ):
            admin_obj._do_confirmed_save(confirm_request, pending)

        self.assertIsNotNone(restored["file"])
        self.assertEqual(restored["file"].name, "doc.txt")
        self.assertEqual(restored["file"].read(), b"hello-bytes")
        # Cache entry consumed during restore.
        self.assertIsNone(cache.get(cache_key))

    def test_invalid_replacement_clears_old_pending_token_and_cached_files(self):
        admin_obj = _host_admin()
        factory = RequestFactory()
        first_request = _wire_request(
            factory.post(
                "/admin/",
                {"hostname": "first-valid.com", "is_active": "on"},
            )
        )
        first_request.FILES["attachment"] = SimpleUploadedFile(
            "first.txt",
            b"first-payload",
            content_type="text/plain",
        )

        first_response = admin_obj.changeform_view(first_request, object_id=None)

        self.assertIsInstance(first_response, HttpResponseRedirect)
        session_key = admin_obj._session_key()
        old_pending = first_request.session[session_key]
        old_token = old_pending["token"]
        old_cache_key = old_pending["file_keys"]["attachment"]
        self.assertIsNotNone(cache.get(old_cache_key))

        second_request = _wire_request(
            factory.post(
                "/admin/",
                {"hostname": "", "is_active": "on"},
            )
        )
        second_request.session = first_request.session
        normal_change_form = object()
        with patch(
            "django.contrib.admin.options.ModelAdmin.changeform_view",
            return_value=normal_change_form,
        ):
            second_response = admin_obj.changeform_view(second_request, object_id=None)

        self.assertIs(second_response, normal_change_form)
        self.assertNotIn(session_key, second_request.session)
        self.assertIsNone(cache.get(old_cache_key))
        self.assertNotEqual(second_request.session.get(session_key, {}).get("token"), old_token)


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class DeleteViewBranchesTest(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.admin = _host_admin()
        self.host = CMSEmbedAllowedHost.objects.create(hostname="del.com", is_active=True)

    def test_skip_confirmation_defers_to_super(self):
        request = _wire_request(self.factory.post("/admin/", {"_autosave": "1", "post": "yes"}))
        sentinel = object()
        with patch(
            "django.contrib.admin.options.ModelAdmin.delete_view",
            return_value=sentinel,
        ) as super_del:
            result = self.admin.delete_view(request, str(self.host.pk))
        self.assertIs(result, sentinel)
        super_del.assert_called_once()

    def test_confirmed_delete_key_routes_to_executor(self):
        request = _wire_request(self.factory.post("/admin/", {"_confirmed_delete": "1", "post": "yes"}))
        sentinel = object()
        with patch.object(self.admin, "_execute_confirmed_delete", return_value=sentinel) as exec_del:
            result = self.admin.delete_view(request, str(self.host.pk))
        self.assertIs(result, sentinel)
        exec_del.assert_called_once()

    def test_missing_object_defers_to_super(self):
        request = _wire_request(self.factory.post("/admin/", {"post": "yes"}))
        sentinel = object()
        with (
            patch.object(self.admin, "get_object", return_value=None),
            patch(
                "django.contrib.admin.options.ModelAdmin.delete_view",
                return_value=sentinel,
            ) as super_del,
        ):
            result = self.admin.delete_view(request, "deadbeef")
        self.assertIs(result, sentinel)
        super_del.assert_called_once()


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ExecuteConfirmedTest(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.admin = _host_admin()

    def test_execute_confirmed_save_strips_marker(self):
        request = _wire_request(self.factory.post("/admin/", {"_confirmed_save": "1", "hostname": "y.com"}))
        captured = {}

        def capture(req, object_id, form_url, extra):
            captured["post"] = req.POST
            return "OK"

        with patch("django.contrib.admin.options.ModelAdmin.changeform_view", side_effect=capture):
            self.admin._execute_confirmed_save(request, None, "", None)
        self.assertNotIn("_confirmed_save", captured["post"])
        self.assertIn("hostname", captured["post"])

    def test_execute_confirmed_delete_strips_marker(self):
        request = _wire_request(self.factory.post("/admin/", {"_confirmed_delete": "1", "post": "yes"}))
        captured = {}

        def capture(req, object_id, extra):
            captured["post"] = req.POST
            return "OK"

        with patch("django.contrib.admin.options.ModelAdmin.delete_view", side_effect=capture):
            self.admin._execute_confirmed_delete(request, "id", None)
        self.assertNotIn("_confirmed_delete", captured["post"])


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ResponseActionBranchesTest(TestCase):
    """Cover the short-circuit branches inside response_action."""

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = _semester_admin()

    def _request(self, data):
        qd = QueryDict(mutable=True)
        for key, value in data.items():
            if isinstance(value, list):
                qd.setlist(key, value)
            else:
                qd[key] = value
        request = self.factory.post("/admin/", data=qd)
        return _wire_request(request)

    def test_confirmed_action_marker_defers_to_super(self):
        request = self._request({"_confirmed_action": "1"})
        sentinel = object()
        with patch(
            "django.contrib.admin.options.ModelAdmin.response_action",
            return_value=sentinel,
        ) as super_action:
            result = self.admin.response_action(request, Semester.objects.all())
        self.assertIs(result, sentinel)
        super_action.assert_called_once()

    def test_non_integer_index_defaults_and_defers(self):
        # Bad index -> action_index 0, but no "action" list -> IndexError -> super().
        request = self._request({"index": "notanint"})
        sentinel = object()
        with patch(
            "django.contrib.admin.options.ModelAdmin.response_action",
            return_value=sentinel,
        ) as super_action:
            result = self.admin.response_action(request, Semester.objects.all())
        self.assertIs(result, sentinel)
        super_action.assert_called_once()

    def test_invalid_action_form_defers(self):
        request = self._request(
            {
                "action": ["not_a_real_action"],
                "index": "0",
                helpers.ACTION_CHECKBOX_NAME: ["x"],
            }
        )
        sentinel = object()
        with patch(
            "django.contrib.admin.options.ModelAdmin.response_action",
            return_value=sentinel,
        ) as super_action:
            result = self.admin.response_action(request, Semester.objects.all())
        self.assertIs(result, sentinel)
        super_action.assert_called_once()

    def test_no_selection_no_select_across_defers(self):
        request = self._request(
            {
                "action": ["publish_selected"],
                "index": "0",
                "select_across": "0",
                helpers.ACTION_CHECKBOX_NAME: [],
            }
        )
        sentinel = object()
        with patch(
            "django.contrib.admin.options.ModelAdmin.response_action",
            return_value=sentinel,
        ) as super_action:
            result = self.admin.response_action(request, Semester.objects.all())
        self.assertIs(result, sentinel)
        super_action.assert_called_once()

    def test_no_matching_pks_defers(self):
        # A valid selection that filters to zero rows -> super() at the action_pks guard.
        request = self._request(
            {
                "action": ["publish_selected"],
                "index": "0",
                "select_across": "0",
                helpers.ACTION_CHECKBOX_NAME: ["00000000-0000-0000-0000-000000000000"],
            }
        )
        sentinel = object()
        with patch(
            "django.contrib.admin.options.ModelAdmin.response_action",
            return_value=sentinel,
        ) as super_action:
            result = self.admin.response_action(request, Semester.objects.none())
        self.assertIs(result, sentinel)
        super_action.assert_called_once()

    def test_action_removed_after_validation_defers(self):
        """If the action vanishes from get_actions after form validation, defer to super."""
        semester = Semester.objects.create(year=2025, season=1, is_published=False)
        request = self._request(
            {
                "action": ["publish_selected"],
                "index": "0",
                "select_across": "0",
                helpers.ACTION_CHECKBOX_NAME: [str(semester.pk)],
            }
        )
        sentinel = object()
        real_get_actions = self.admin.get_actions
        calls = {"n": 0}

        def shrinking_get_actions(req):
            calls["n"] += 1
            # First calls (form choices, skip check) keep the action; the membership
            # guard at line ~324 sees it gone.
            actions = dict(real_get_actions(req))
            if calls["n"] >= 3:
                actions.pop("publish_selected", None)
            return actions

        with (
            patch.object(self.admin, "get_actions", side_effect=shrinking_get_actions),
            patch(
                "django.contrib.admin.options.ModelAdmin.response_action",
                return_value=sentinel,
            ) as super_action,
        ):
            result = self.admin.response_action(request, Semester.objects.all())
        self.assertIs(result, sentinel)
        super_action.assert_called_once()

    def test_description_format_error_falls_back_to_plain(self):
        """A description with an unmappable %-placeholder uses the raw description."""
        semester = Semester.objects.create(year=2025, season=1, is_published=False)
        request = self._request(
            {
                "action": ["publish_selected"],
                "index": "0",
                "select_across": "0",
                helpers.ACTION_CHECKBOX_NAME: [str(semester.pk)],
            }
        )
        real_get_actions = self.admin.get_actions

        # Django's get_action_choices formats with the full model_format_dict
        # (which includes verbose_name); the mixin only supplies
        # verbose_name_plural, so this key raises a KeyError there and falls
        # back to the raw description string.
        bad_desc = "Publish %(verbose_name)s now"

        def bad_description(req):
            actions = dict(real_get_actions(req))
            func, name, _desc = actions["publish_selected"]
            actions["publish_selected"] = (func, name, bad_desc)
            return actions

        with patch.object(self.admin, "get_actions", side_effect=bad_description):
            response = self.admin.response_action(request, Semester.objects.all())
        self.assertIsInstance(response, HttpResponseRedirect)
        pending = request.session[self.admin._session_action_key()]
        # KeyError on the format -> stored description is the raw string.
        self.assertEqual(pending["action_description"], bad_desc)

    def test_action_with_no_confirmation_attr_skips(self):
        semester = Semester.objects.create(year=2025, season=1, is_published=False)
        request = self._request(
            {
                "action": ["publish_selected"],
                "index": "0",
                "select_across": "0",
                helpers.ACTION_CHECKBOX_NAME: [str(semester.pk)],
            }
        )
        sentinel = object()
        # Patch the action func to carry no_confirmation = True so it skips.
        actions = dict(self.admin.get_actions(request))
        func = actions["publish_selected"][0]
        with (
            patch.object(func, "no_confirmation", True, create=True),
            patch(
                "django.contrib.admin.options.ModelAdmin.response_action",
                return_value=sentinel,
            ) as super_action,
        ):
            result = self.admin.response_action(request, Semester.objects.all())
        self.assertIs(result, sentinel)
        super_action.assert_called_once()


@override_settings(ADMIN_REQUIRE_CONFIRMATION=True)
class ExecuteConfirmedActionTest(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.admin = _semester_admin()

    def test_action_no_longer_available(self):
        request = _wire_request(self.factory.post("/admin/"))
        pending = {
            "action_name": "vanished_action",
            "selected_pks": [],
            "select_across": False,
            "queryset_pks": [],
        }
        request.session[self.admin._session_action_key()] = pending
        response = self.admin._execute_confirmed_action(request, pending)
        self.assertIsInstance(response, HttpResponseRedirect)
        messages_list = [str(m) for m in request._messages]
        self.assertIn("Action no longer available.", messages_list)

    def test_falls_back_to_changelist_when_action_returns_none(self):
        semester = Semester.objects.create(year=2025, season=1, is_published=False)
        request = _wire_request(self.factory.post("/admin/"))
        pending = {
            "action_name": "publish_selected",
            "selected_pks": [str(semester.pk)],
            "select_across": False,
            "queryset_pks": [str(semester.pk)],
        }
        # publish_selected returns None -> redirect to changelist.
        response = self.admin._execute_confirmed_action(request, pending)
        self.assertIsInstance(response, HttpResponseRedirect)
        semester.refresh_from_db()
        self.assertTrue(semester.is_published)

    def test_queryset_pks_none_uses_selected(self):
        semester = Semester.objects.create(year=2025, season=1, is_published=False)
        request = _wire_request(self.factory.post("/admin/"))
        pending = {
            "action_name": "publish_selected",
            "selected_pks": [str(semester.pk)],
            "select_across": False,
            "queryset_pks": None,
        }
        self.admin._execute_confirmed_action(request, pending)
        semester.refresh_from_db()
        self.assertTrue(semester.is_published)

    def test_action_returning_http_response_is_passed_through(self):
        """When the action returns an HttpResponse, it is returned directly."""
        from django.http import HttpResponse

        semester = Semester.objects.create(year=2025, season=1, is_published=False)
        request = _wire_request(self.factory.post("/admin/"))
        pending = {
            "action_name": "publish_selected",
            "selected_pks": [str(semester.pk)],
            "select_across": False,
            "queryset_pks": [str(semester.pk)],
        }
        custom_response = HttpResponse("custom body")
        real_get_actions = self.admin.get_actions

        def with_response_action(req):
            actions = dict(real_get_actions(req))
            _func, name, desc = actions["publish_selected"]
            actions["publish_selected"] = (lambda admin, r, qs: custom_response, name, desc)
            return actions

        with patch.object(self.admin, "get_actions", side_effect=with_response_action):
            response = self.admin._execute_confirmed_action(request, pending)
        self.assertIs(response, custom_response)
