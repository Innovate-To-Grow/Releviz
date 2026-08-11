"""Tests for member-to-Google-Sheet sync service."""

import importlib
from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.apps import apps
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from apps.authn.models import ContactEmail, ContactPhone, Member, MemberSheetSyncConfig, MemberSheetSyncLog
from apps.authn.services.members.sheet_sync import (
    MemberSyncError,
    _build_header,
    _build_row,
    _safe,
    sync_members_to_sheet,
)
from apps.core.models import BackgroundJob


def _create_member(first="Alice", middle="", last="Smith", org="Acme", title="Dev", active=True):
    member = Member.objects.create_user(
        password="TestPass123!",
        first_name=first,
        middle_name=middle or "",
        last_name=last,
        organization=org,
        title=title,
        is_active=active,
    )
    ContactEmail.objects.create(member=member, email_address=f"{first.lower()}@example.com", email_type="primary")
    return member


def _enable_config(sheet_id="test-sheet-id", auto_sync=True):
    return MemberSheetSyncConfig.objects.create(is_enabled=True, auto_sync_enabled=auto_sync, google_sheet_id=sheet_id)


class BuildHeaderTests(TestCase):
    def test_header_columns(self):
        header = _build_header()
        self.assertEqual(
            header,
            [
                "UUID",
                "First Name",
                "Middle Name",
                "Last Name",
                "Primary Email",
                "Primary Phone",
                "Organization",
                "Title",
                "Date Joined (UTC)",
                "Last Updated (UTC)",
                "Active",
            ],
        )


class BuildRowTests(TestCase):
    def test_basic_row(self):
        member = _create_member()
        member = Member.objects.prefetch_related("contact_emails", "contact_phones").get(pk=member.pk)
        row = _build_row(member)
        self.assertEqual(row[0], str(member.id))
        self.assertEqual(row[1], "Alice")
        self.assertEqual(row[2], "")  # no middle name
        self.assertEqual(row[3], "Smith")
        self.assertEqual(row[4], "alice@example.com")
        self.assertEqual(row[5], "")  # no phone
        self.assertEqual(row[6], "Acme")
        self.assertEqual(row[7], "Dev")
        self.assertEqual(row[10], "Yes")

    def test_middle_name_present(self):
        member = _create_member(first="Bob", middle="James", last="Doe")
        member = Member.objects.prefetch_related("contact_emails", "contact_phones").get(pk=member.pk)
        row = _build_row(member)
        self.assertEqual(row[2], "James")

    def test_inactive_member(self):
        member = _create_member(first="Inactive", active=False)
        member = Member.objects.prefetch_related("contact_emails", "contact_phones").get(pk=member.pk)
        row = _build_row(member)
        self.assertEqual(row[10], "No")

    def test_phone_present(self):
        member = _create_member(first="Phoney")
        ContactPhone.objects.create(member=member, phone_number="2095551234", region="1-US")
        member = Member.objects.prefetch_related("contact_emails", "contact_phones").get(pk=member.pk)
        row = _build_row(member)
        self.assertEqual(row[5], "2095551234")

    def test_missing_email(self):
        member = Member.objects.create_user(
            password="TestPass123!", first_name="NoEmail", last_name="User", is_active=True
        )
        member = Member.objects.prefetch_related("contact_emails", "contact_phones").get(pk=member.pk)
        row = _build_row(member)
        self.assertEqual(row[4], "")


class SyncDisabledTests(TestCase):
    def test_raises_when_not_configured(self):
        with self.assertRaises(MemberSyncError):
            sync_members_to_sheet()

    def test_raises_when_disabled(self):
        MemberSheetSyncConfig.objects.create(is_enabled=False, google_sheet_id="sheet-id")
        with self.assertRaises(MemberSyncError):
            sync_members_to_sheet()

    def test_raises_when_sheet_id_empty(self):
        MemberSheetSyncConfig.objects.create(is_enabled=True, google_sheet_id="")
        with self.assertRaises(MemberSyncError):
            sync_members_to_sheet()


@patch("apps.authn.services.members.sheet_sync._get_worksheet")
class FullSyncTests(TestCase):
    def setUp(self):
        _enable_config()

    @patch("apps.authn.services.members.sheet_sync.GoogleCredentialConfig")
    def test_full_replace_calls_clear_and_update(self, mock_cred_cls, mock_get_ws):
        mock_cred = MagicMock()
        mock_cred.is_configured = True
        mock_cred_cls.load.return_value = mock_cred

        mock_ws = MagicMock()
        mock_get_ws.return_value = mock_ws

        m1 = _create_member(first="Alice")
        m2 = _create_member(first="Bob", active=False)

        rows = sync_members_to_sheet(sync_type="full")

        self.assertEqual(rows, 2)
        mock_ws.clear.assert_called_once()
        call_args = mock_ws.update.call_args
        data = call_args[0][0]
        self.assertEqual(data[0], _build_header())
        self.assertEqual(len(data), 3)  # header + 2 rows
        self.assertEqual(data[1][1], "Alice")
        self.assertEqual(data[2][1], "Bob")

        config = MemberSheetSyncConfig.load()
        self.assertEqual(config.sync_count, 2)
        self.assertEqual(config.sync_error, "")
        self.assertIsNotNone(config.synced_at)

        log = MemberSheetSyncLog.objects.first()
        self.assertEqual(log.status, "success")
        self.assertEqual(log.rows_written, 2)

    @patch("apps.authn.services.members.sheet_sync.GoogleCredentialConfig")
    def test_failure_records_error_and_log(self, mock_cred_cls, mock_get_ws):
        mock_cred = MagicMock()
        mock_cred.is_configured = True
        mock_cred_cls.load.return_value = mock_cred

        mock_ws = MagicMock()
        mock_ws.update.side_effect = RuntimeError("API quota exceeded")
        mock_get_ws.return_value = mock_ws

        _create_member()

        with self.assertRaises(MemberSyncError):
            sync_members_to_sheet(sync_type="full")

        config = MemberSheetSyncConfig.load()
        self.assertIn("API quota exceeded", config.sync_error)

        log = MemberSheetSyncLog.objects.first()
        self.assertEqual(log.status, "failed")
        self.assertIn("API quota exceeded", log.error_message)

    @patch("apps.authn.services.members.sheet_sync.GoogleCredentialConfig")
    def test_empty_member_table(self, mock_cred_cls, mock_get_ws):
        mock_cred = MagicMock()
        mock_cred.is_configured = True
        mock_cred_cls.load.return_value = mock_cred

        mock_ws = MagicMock()
        mock_get_ws.return_value = mock_ws

        rows = sync_members_to_sheet(sync_type="full")

        self.assertEqual(rows, 0)
        mock_ws.clear.assert_called_once()
        data = mock_ws.update.call_args[0][0]
        self.assertEqual(len(data), 1)  # header only


class ScheduleMemberSyncTests(TestCase):
    def test_noop_when_not_configured(self):
        from apps.authn.services.members.sheet_sync import schedule_member_sync

        schedule_member_sync()  # should not raise

        self.assertFalse(BackgroundJob.objects.exists())

    @override_settings(BACKGROUND_JOBS_ENABLED=True)
    def test_noop_when_auto_sync_disabled(self):
        _enable_config(auto_sync=False)

        from apps.authn.services.members.sheet_sync import schedule_member_sync

        schedule_member_sync()

        self.assertFalse(BackgroundJob.objects.exists())

    @override_settings(BACKGROUND_JOBS_ENABLED=True)
    def test_enqueues_durable_job_when_configured(self):
        _enable_config()

        from apps.authn.services.members.sheet_sync import schedule_member_sync

        schedule_member_sync()

        self.assertTrue(
            BackgroundJob.objects.filter(
                kind="authn.member_sheet_sync",
                status=BackgroundJob.Status.PENDING,
            ).exists()
        )

    @override_settings(BACKGROUND_JOBS_ENABLED=False)
    @patch("apps.authn.services.members.sheet_sync.scheduler._schedule_in_process_sync")
    def test_rollout_fallback_schedules_nonblocking_debounce(self, schedule):
        _enable_config()

        from apps.authn.services.members.sheet_sync import schedule_member_sync

        schedule_member_sync()

        schedule.assert_called_once_with(delay=15)

    @override_settings(BACKGROUND_JOBS_ENABLED=False)
    @patch("apps.authn.services.members.sheet_sync.scheduler.threading.Timer")
    def test_rollout_timer_start_failure_is_logged_and_suppressed(self, timer_class):
        from apps.authn.services.members.sheet_sync import scheduler

        _enable_config()
        scheduler._sync_timer = None
        timer_class.return_value.start.side_effect = RuntimeError("can't start new thread")

        with self.assertLogs(scheduler.logger, level="ERROR"):
            scheduler.schedule_member_sync()

        self.assertIsNone(scheduler._sync_timer)

    @patch("apps.authn.services.members.sheet_sync.scheduler.threading.Timer")
    def test_rollout_timer_replaces_and_cancels_previous_debounce(self, timer_class):
        from apps.authn.services.members.sheet_sync import scheduler

        previous = MagicMock()
        scheduler._sync_timer = previous
        self.addCleanup(setattr, scheduler, "_sync_timer", None)

        scheduler._schedule_in_process_sync(delay=3)

        timer = timer_class.return_value
        previous.cancel.assert_called_once_with()
        timer_class.assert_called_once_with(3, scheduler._run_in_process_sync)
        self.assertIs(scheduler._sync_timer, timer)
        self.assertTrue(timer.daemon)
        timer.start.assert_called_once_with()

    def test_stale_rollout_timer_cannot_clear_or_run_newer_debounce(self):
        from apps.authn.services.members.sheet_sync import scheduler

        stale_timer = MagicMock()
        current_timer = MagicMock()
        scheduler._sync_timer = current_timer
        self.addCleanup(setattr, scheduler, "_sync_timer", None)

        with (
            patch.object(scheduler.threading, "current_thread", return_value=stale_timer),
            patch.object(scheduler, "_flush_pending_sync") as flush,
            patch.object(scheduler, "close_old_connections") as close_connections,
        ):
            scheduler._run_in_process_sync()

        self.assertIs(scheduler._sync_timer, current_timer)
        flush.assert_not_called()
        close_connections.assert_not_called()

    def test_current_rollout_timer_clears_cache_and_refreshes_connections(self):
        from apps.authn.services.members.sheet_sync import scheduler

        current_timer = MagicMock()
        scheduler._sync_timer = current_timer
        self.addCleanup(setattr, scheduler, "_sync_timer", None)

        with (
            patch.object(scheduler.threading, "current_thread", return_value=current_timer),
            patch.object(scheduler, "_flush_pending_sync") as flush,
            patch.object(scheduler, "close_old_connections") as close_connections,
        ):
            scheduler._run_in_process_sync()

        self.assertIsNone(scheduler._sync_timer)
        flush.assert_called_once_with()
        self.assertEqual(close_connections.call_count, 2)


class FormulaInjectionTests(TestCase):
    def test_safe_passes_through_plain_text(self):
        self.assertEqual(_safe("Alice"), "Alice")
        self.assertEqual(_safe(""), "")
        self.assertEqual(_safe(None), "")

    def test_safe_escapes_each_trigger(self):
        for trigger in ("=", "+", "-", "@", "\t", "\r"):
            payload = f"{trigger}HACK()"
            self.assertEqual(_safe(payload), f"'{payload}", f"trigger {trigger!r} not escaped")

    def test_build_row_escapes_formula_in_first_name(self):
        member = _create_member(first='=HYPERLINK("https://evil/","x")')
        member = Member.objects.prefetch_related("contact_emails", "contact_phones").get(pk=member.pk)
        row = _build_row(member)
        self.assertTrue(row[1].startswith("'="))

    def test_build_row_escapes_formula_in_organization(self):
        member = _create_member(org="@SUM(A1:A10)")
        member = Member.objects.prefetch_related("contact_emails", "contact_phones").get(pk=member.pk)
        row = _build_row(member)
        self.assertTrue(row[6].startswith("'@"))


class SingletonEnforcementTests(TestCase):
    def test_load_does_not_fall_back_to_disabled_config(self):
        stale = MemberSheetSyncConfig.objects.create(
            is_enabled=False,
            google_sheet_id="stale-sheet",
        )

        loaded = MemberSheetSyncConfig.load()

        self.assertNotEqual(loaded.pk, stale.pk)
        self.assertTrue(loaded._state.adding)
        self.assertFalse(loaded.is_configured)

    def test_saving_enabled_config_disables_others(self):
        first = MemberSheetSyncConfig.objects.create(is_enabled=True, google_sheet_id="sheet-a")
        second = MemberSheetSyncConfig.objects.create(is_enabled=True, google_sheet_id="sheet-b")
        first.refresh_from_db()
        self.assertFalse(first.is_enabled)
        self.assertTrue(second.is_enabled)

    def test_saving_disabled_config_leaves_others_alone(self):
        enabled = MemberSheetSyncConfig.objects.create(is_enabled=True, google_sheet_id="sheet-a")
        MemberSheetSyncConfig.objects.create(is_enabled=False, google_sheet_id="sheet-b")
        enabled.refresh_from_db()
        self.assertTrue(enabled.is_enabled)

    def test_migration_preserves_all_disabled_configs(self):
        older = MemberSheetSyncConfig.objects.create(is_enabled=False, google_sheet_id="sheet-a")
        newer = MemberSheetSyncConfig.objects.create(is_enabled=False, google_sheet_id="sheet-b")
        now = timezone.now()
        MemberSheetSyncConfig.objects.filter(pk=older.pk).update(updated_at=now - timedelta(days=1))
        MemberSheetSyncConfig.objects.filter(pk=newer.pk).update(updated_at=now)
        normalize = importlib.import_module("apps.authn.migrations.0017_auth_security_invariants").normalize_singletons

        normalize(apps, None)

        older.refresh_from_db()
        newer.refresh_from_db()
        self.assertFalse(older.is_enabled)
        self.assertFalse(newer.is_enabled)


@override_settings(BACKGROUND_JOBS_ENABLED=True)
class DurableFollowUpTests(TestCase):
    def setUp(self):
        _enable_config()

    def test_change_during_processing_creates_follow_up_job(self):
        from apps.authn.services.members.sheet_sync import schedule_member_sync

        schedule_member_sync()
        first = BackgroundJob.objects.get()
        BackgroundJob.objects.filter(pk=first.pk).update(
            status=BackgroundJob.Status.PROCESSING,
            claim_token=BackgroundJob.new_claim_token(),
        )

        schedule_member_sync()

        self.assertEqual(BackgroundJob.objects.count(), 2)
        self.assertEqual(
            BackgroundJob.objects.filter(status=BackgroundJob.Status.PENDING).count(),
            1,
        )


class SignalSchedulingTests(TransactionTestCase):
    """post_save / post_delete on Member, ContactEmail, ContactPhone fire schedule_member_sync."""

    @patch("apps.authn.services.members.sheet_sync.schedule_member_sync")
    def test_member_save_triggers_schedule(self, mock_schedule):
        Member.objects.create_user(password="TestPass123!", first_name="Sig", last_name="Nal")
        self.assertTrue(mock_schedule.called)

    @patch("apps.authn.services.members.sheet_sync.schedule_member_sync")
    def test_member_delete_triggers_schedule(self, mock_schedule):
        member = Member.objects.create_user(password="TestPass123!", first_name="Del", last_name="Me")
        mock_schedule.reset_mock()
        member.delete()
        self.assertTrue(mock_schedule.called)

    @patch("apps.authn.services.members.sheet_sync.schedule_member_sync")
    def test_contact_email_save_triggers_schedule(self, mock_schedule):
        member = Member.objects.create_user(password="TestPass123!", first_name="Ce", last_name="Mail")
        mock_schedule.reset_mock()
        ContactEmail.objects.create(member=member, email_address="ce@example.com", email_type="primary")
        self.assertTrue(mock_schedule.called)

    @patch("apps.authn.services.members.sheet_sync.schedule_member_sync")
    def test_contact_phone_save_triggers_schedule(self, mock_schedule):
        member = Member.objects.create_user(password="TestPass123!", first_name="Ph", last_name="One")
        mock_schedule.reset_mock()
        ContactPhone.objects.create(member=member, phone_number="2095551234", region="1-US")
        self.assertTrue(mock_schedule.called)
