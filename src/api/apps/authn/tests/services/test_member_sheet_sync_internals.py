"""Coverage for member_sheet_sync internals: sheets, scheduler, rows."""

from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.authn.models import ContactEmail, ContactPhone, MemberSheetSyncConfig
from apps.authn.services.members.sheet_sync.rows import build_row
from apps.authn.services.members.sheet_sync.scheduler import (
    _flush_pending_sync,
    schedule_immediate_sync,
    schedule_member_sync,
)
from apps.authn.services.members.sheet_sync.sheets import MemberSyncError, _get_worksheet
from apps.core.models import BackgroundJob

Member = get_user_model()


def _member(**kw):
    member = Member.objects.create_user(
        password="StrongPass123!",
        first_name=kw.pop("first_name", "Alice"),
        last_name=kw.pop("last_name", "Smith"),
        **kw,
    )
    ContactEmail.objects.create(member=member, email_address="alice@example.com", email_type="primary")
    return member


class GetWorksheetTests(TestCase):
    def _config(self, **kw):
        return MemberSheetSyncConfig.objects.create(
            is_enabled=True, google_sheet_id=kw.pop("google_sheet_id", "sheet-id"), **kw
        )

    @patch("apps.authn.services.members.sheet_sync.GoogleCredentialConfig.load")
    def test_raises_when_credentials_not_configured(self, mock_load):
        cred = MagicMock()
        cred.is_configured = False
        mock_load.return_value = cred
        with self.assertRaises(MemberSyncError):
            _get_worksheet(self._config())

    @patch("gspread.service_account_from_dict")
    @patch("apps.authn.services.members.sheet_sync.GoogleCredentialConfig.load")
    def test_returns_sheet1_when_no_gid(self, mock_load, mock_gspread):
        cred = MagicMock()
        cred.is_configured = True
        cred.get_credentials_info.return_value = {"type": "service_account"}
        mock_load.return_value = cred

        sheet1 = MagicMock()
        spreadsheet = MagicMock()
        spreadsheet.sheet1 = sheet1
        mock_gspread.return_value.open_by_key.return_value = spreadsheet

        result = _get_worksheet(self._config())
        self.assertEqual(result, sheet1)

    @patch("gspread.service_account_from_dict")
    @patch("apps.authn.services.members.sheet_sync.GoogleCredentialConfig.load")
    def test_finds_worksheet_by_gid(self, mock_load, mock_gspread):
        cred = MagicMock()
        cred.is_configured = True
        cred.get_credentials_info.return_value = {"type": "service_account"}
        mock_load.return_value = cred

        ws = MagicMock()
        ws.id = 42
        spreadsheet = MagicMock()
        spreadsheet.worksheets.return_value = [ws]
        mock_gspread.return_value.open_by_key.return_value = spreadsheet

        result = _get_worksheet(self._config(worksheet_gid=42))
        self.assertEqual(result, ws)

    @patch("gspread.service_account_from_dict")
    @patch("apps.authn.services.members.sheet_sync.GoogleCredentialConfig.load")
    def test_raises_when_gid_not_found(self, mock_load, mock_gspread):
        cred = MagicMock()
        cred.is_configured = True
        cred.get_credentials_info.return_value = {"type": "service_account"}
        mock_load.return_value = cred

        spreadsheet = MagicMock()
        spreadsheet.worksheets.return_value = []
        mock_gspread.return_value.open_by_key.return_value = spreadsheet

        with self.assertRaises(MemberSyncError):
            _get_worksheet(self._config(worksheet_gid=99))


class SyncMembersErrorTests(TestCase):
    def setUp(self):
        MemberSheetSyncConfig.objects.create(is_enabled=True, auto_sync_enabled=True, google_sheet_id="sheet-id")

    @patch("apps.authn.services.members.sheet_sync._get_worksheet")
    def test_member_sync_error_is_reraised_and_logged(self, mock_get_ws):
        from apps.authn.models import MemberSheetSyncLog
        from apps.authn.services.members.sheet_sync import sync_members_to_sheet

        mock_get_ws.side_effect = MemberSyncError("worksheet missing")
        with self.assertRaises(MemberSyncError):
            sync_members_to_sheet(sync_type="full")

        # A failure log row is recorded (record_sync_failure ran before re-raise).
        self.assertTrue(MemberSheetSyncLog.objects.filter(status=MemberSheetSyncLog.Status.FAILED).exists())


class BuildRowPhoneTests(TestCase):
    def test_build_row_unprefetched_phone_lookup(self):
        # member fetched without prefetch -> build_row queries contact_phones.first() (lines 30-31).
        member = _member()
        ContactPhone.objects.create(member=member, phone_number="2095551234", region="1-US")
        fresh = Member.objects.get(pk=member.pk)
        row = build_row(fresh)
        self.assertIn("2095551234", row)


class SchedulerTests(TestCase):
    @override_settings(BACKGROUND_JOBS_ENABLED=True)
    def test_schedule_immediate_sync_enqueues_ready_job(self):
        before = timezone.now()
        schedule_immediate_sync()

        job = BackgroundJob.objects.get(kind="authn.member_sheet_sync")
        self.assertLessEqual(job.available_at, timezone.now())
        self.assertGreaterEqual(job.available_at, before)

    @override_settings(BACKGROUND_JOBS_ENABLED=True)
    def test_schedule_member_sync_coalesces_queued_job(self):
        MemberSheetSyncConfig.objects.create(is_enabled=True, auto_sync_enabled=True, google_sheet_id="sheet-id")
        schedule_member_sync()
        first = BackgroundJob.objects.get(kind="authn.member_sheet_sync")
        schedule_member_sync()

        self.assertEqual(BackgroundJob.objects.filter(kind="authn.member_sheet_sync").count(), 1)
        first.refresh_from_db()
        self.assertGreater(first.available_at, timezone.now())

    @patch("apps.authn.services.members.sheet_sync.sync_members_to_sheet")
    def test_flush_pending_sync_runs_sync(self, mock_sync):
        _flush_pending_sync()
        mock_sync.assert_called_once()

    @patch(
        "apps.authn.services.members.sheet_sync.sync_members_to_sheet",
        side_effect=RuntimeError("sheets down"),
    )
    def test_flush_pending_sync_swallows_errors(self, mock_sync):
        # Should not raise — the except branch logs and the finally still runs.
        _flush_pending_sync()
        mock_sync.assert_called_once()
