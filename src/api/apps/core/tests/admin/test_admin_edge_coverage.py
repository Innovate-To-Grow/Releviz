from types import SimpleNamespace
from unittest.mock import patch

from django.contrib import admin
from django.http import HttpResponse, QueryDict
from django.test import RequestFactory, TestCase

from apps.core.admin.registrations.background_jobs import BackgroundJobAdmin
from apps.core.admin.registrations.maintenance import SiteMaintenanceControlAdminForm
from apps.core.models import AWSCredentialConfig, BackgroundJob, SiteMaintenanceControl


class ConfirmOnSaveDefensiveEdgeTests(TestCase):
    def setUp(self):
        self.model_admin = admin.site._registry[AWSCredentialConfig]
        self.factory = RequestFactory()

    def test_discard_pending_confirmation_ignores_non_mapping_file_keys(self):
        request = SimpleNamespace(session={"pending": {"file_keys": ["unexpected"]}})

        self.model_admin._discard_pending_confirmation(request, "pending")

        self.assertNotIn("pending", request.session)

    @patch("django.contrib.admin.options.ModelAdmin.changeform_view")
    def test_confirmed_save_ignores_expired_upload_and_preserves_nonredirect_state(
        self, changeform_view
    ):
        response = HttpResponse("invalid form")
        changeform_view.return_value = response
        request = self.factory.post("/")
        request.session = {self.model_admin._session_key(): {"token": "pending"}}
        original_post = request.POST
        pending = {
            "post_data": {"name": ["Changed"]},
            "object_id": None,
            "form_url": "",
            "file_keys": {"attachment": "expired-cache-key"},
        }

        self.assertIs(self.model_admin._do_confirmed_save(request, pending), response)
        self.assertIs(request.POST, original_post)
        self.assertIn(self.model_admin._session_key(), request.session)

    @patch("django.contrib.admin.options.ModelAdmin.delete_view")
    def test_confirmed_delete_preserves_pending_state_for_nonredirect_response(self, delete_view):
        response = HttpResponse("cannot delete")
        delete_view.return_value = response
        request = self.factory.post("/")
        request.session = {self.model_admin._session_key(): {"token": "pending"}}
        pending = {"post_data": {"post": ["yes"]}, "object_id": "object-id"}

        self.assertIs(self.model_admin._do_confirmed_delete(request, pending), response)
        self.assertIn(self.model_admin._session_key(), request.session)

    def test_registered_action_without_opt_out_requires_confirmation(self):
        request = self.factory.post("/")

        def action_function(_model_admin, _request, _queryset):
            return None

        with patch.object(
            self.model_admin,
            "get_actions",
            return_value={"ordinary": (action_function, "ordinary", "Ordinary")},
        ):
            self.assertFalse(self.model_admin._action_skips_confirmation("ordinary", request))
        with patch.object(self.model_admin, "get_actions", return_value={}):
            self.assertFalse(self.model_admin._action_skips_confirmation("missing", request))


class BackgroundJobAdminEdgeTests(TestCase):
    def setUp(self):
        self.model_admin = BackgroundJobAdmin(BackgroundJob, admin.site)
        self.request = RequestFactory().post("/")

    @patch.object(BackgroundJobAdmin, "message_user")
    @patch("apps.core.admin.registrations.background_jobs.retry_job", return_value=False)
    def test_retry_action_warns_when_no_job_is_terminal(self, retry_job, message_user):
        jobs = [SimpleNamespace(pk=1), SimpleNamespace(pk=2)]

        self.model_admin.retry_selected_jobs(self.request, jobs)

        self.assertEqual(retry_job.call_count, 2)
        self.assertIn("No failed", message_user.call_args.args[1])

    @patch.object(BackgroundJobAdmin, "message_user")
    @patch(
        "apps.core.admin.registrations.background_jobs.retry_job",
        side_effect=[False, True],
    )
    def test_retry_action_counts_only_successful_transitions(self, _retry_job, message_user):
        self.model_admin.retry_selected_jobs(
            self.request,
            [SimpleNamespace(pk=1), SimpleNamespace(pk=2)],
        )

        self.assertIn("Queued 1 job", message_user.call_args.args[1])


class MaintenanceAdminFormEdgeTests(TestCase):
    def test_nonblank_replacement_is_preserved_by_clean(self):
        config = SiteMaintenanceControl.objects.create(
            is_maintenance=True,
            bypass_password="old-secret",
        )
        form = SiteMaintenanceControlAdminForm(
            data=QueryDict("is_maintenance=on&message=Maintenance&bypass_password=new-secret"),
            instance=config,
        )

        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(form.cleaned_data["bypass_password"], "new-secret")
