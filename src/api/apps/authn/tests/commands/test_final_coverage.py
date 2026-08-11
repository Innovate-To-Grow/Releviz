"""Coverage for management commands: sync_members_to_sheet."""

from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.test import TestCase

from apps.authn.management.sync_members_to_sheet import Command as SyncMembersCommand
from apps.authn.services.members.sheet_sync import MemberSyncError


class SyncMembersCommandTests(TestCase):
    @patch("apps.authn.management.sync_members_to_sheet.sync_members_to_sheet", return_value=4)
    def test_command_success(self, mock_sync):
        from io import StringIO

        out = StringIO()
        call_command(SyncMembersCommand(), stdout=out)
        self.assertIn("Synced 4 members to sheet.", out.getvalue())

    @patch(
        "apps.authn.management.sync_members_to_sheet.sync_members_to_sheet",
        side_effect=MemberSyncError("not configured"),
    )
    def test_command_failure_raises_command_error(self, mock_sync):
        with self.assertRaisesMessage(CommandError, "Sync failed: not configured"):
            call_command(SyncMembersCommand())
