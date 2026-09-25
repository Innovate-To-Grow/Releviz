import io
import uuid
import zipfile
from datetime import timedelta
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.utils import timezone
from openpyxl import Workbook
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.mail.services import enqueue_email_job
from apps.scheduling.models import (
    Event,
    EventInvitation,
    EventResultSnapshot,
    Participant,
    ParticipantGroup,
    RosterBulkUpdateReceipt,
    RosterImportBatch,
    RosterImportReceipt,
    TemporaryEventSession,
    UserEvent,
    Weight,
)


class RosterImportApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("owner@example.com", "Event", "Owner")
        self.outsider = create_member("outsider@example.com", "Other", "Person")
        self.event = Event.objects.create(
            code="ROSTER01",
            name="Large event",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        UserEvent.objects.create(member=self.organizer, event=self.event, role="organizer")
        self.authenticate(self.organizer)

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def paste(self, content, *, event=None):
        event = event or self.event
        return self.client.post(
            f"/events/roster-imports?code={event.code}",
            {"sourceType": "paste", "pastedText": content},
            format="json",
        )

    def commit(
        self,
        import_id,
        *,
        mode="merge",
        key=None,
        confirmation=None,
        event=None,
        send_invitations=None,
    ):
        event = event or self.event
        payload = {
            "mode": mode,
            "idempotencyKey": str(key or uuid.uuid4()),
        }
        if confirmation is not None:
            payload["confirmationCode"] = confirmation
        if send_invitations is not None:
            payload["sendInvitations"] = send_invitations
        return self.client.post(
            f"/events/roster-imports/{import_id}/commit?code={event.code}",
            payload,
            format="json",
        )

    def test_model_defaults_match_scaled_event_contract(self):
        self.assertEqual(self.event.status, Event.Status.ACTIVE)
        self.assertEqual(self.event.access_mode, "invite_only")
        self.assertEqual(self.event.meeting_duration_minutes, 30)
        self.assertEqual(self.event.results_revision, 1)
        self.assertNotIn("required", {field.name for field in Weight._meta.fields})

    def test_paste_preview_normalizes_identical_and_conflicting_duplicates(self):
        response = self.paste(
            "name\temail\tgroup\tweight\tincluded\n"
            "Alice\tALICE@example.com\tA\t0.5\tyes\n"
            "Alice\talice@example.com\tA\t0.5\ttrue\n"
            "Bob\tbob@example.com\tB\t1\tyes\n"
            "Robert\tbob@example.com\tB\t0.8\tyes\n"
        )

        self.assertEqual(response.status_code, 201)
        self.assertIn("private", response["Cache-Control"])
        self.assertIn("no-store", response["Cache-Control"])
        import_payload = response.data["import"]
        self.assertEqual(import_payload["selectedWorksheet"], "Pasted data")
        self.assertEqual(
            import_payload["columnMapping"],
            {"name": 0, "email": 1, "group": 2, "weight": 3, "included": 4},
        )
        self.assertEqual(import_payload["summary"]["selected"], 3)
        self.assertEqual(import_payload["summary"]["valid"], 1)
        self.assertEqual(import_payload["summary"]["conflicts"], 2)

        rows = self.client.get(
            f"/events/roster-imports/{import_payload['id']}/rows?code={self.event.code}"
        )
        self.assertEqual(rows.status_code, 200)
        self.assertEqual(rows.data["pagination"]["total"], 4)
        self.assertEqual(rows.data["rows"][0]["email"], "alice@example.com")
        self.assertEqual(rows.data["rows"][1]["duplicate"], "identical")
        self.assertFalse(rows.data["rows"][1]["selected"])
        self.assertEqual(rows.data["rows"][2]["duplicate"], "conflict")
        # A sheet without a phone column still echoes the key on every row.
        self.assertEqual([row["phone"] for row in rows.data["rows"]], ["", "", "", ""])

    def test_phone_column_is_auto_mapped_and_validated(self):
        response = self.paste(
            "name,email,Mobile\n"
            "Valid,valid@example.com,+1 (555) 010-2000\n"
            "Blank,blank@example.com,\n"
            "Short,short@example.com,12345\n"
            "Letters,letters@example.com,555-CALL-NOW\n"
            f"Long,long@example.com,{'1' * 33}\n"
            "Formula,formula@example.com,=CONCAT(5)\n"
        )
        self.assertEqual(response.status_code, 201, response.data)
        import_payload = response.data["import"]
        self.assertEqual(import_payload["columnMapping"], {"name": 0, "email": 1, "phone": 2})
        self.assertEqual(
            import_payload["summary"],
            {"total": 6, "selected": 6, "valid": 2, "invalid": 4, "conflicts": 0},
        )

        rows = self.client.get(
            f"/events/roster-imports/{import_payload['id']}/rows?code={self.event.code}"
        )
        self.assertEqual(rows.status_code, 200)
        by_email = {row["email"]: row for row in rows.data["rows"]}
        self.assertEqual(by_email["valid@example.com"]["phone"], "+1 (555) 010-2000")
        self.assertEqual(by_email["valid@example.com"]["errors"], [])
        self.assertEqual(by_email["blank@example.com"]["phone"], "")
        self.assertTrue(by_email["blank@example.com"]["valid"])
        self.assertEqual(by_email["short@example.com"]["errors"], ["phone is invalid."])
        self.assertEqual(by_email["letters@example.com"]["errors"], ["phone is invalid."])
        self.assertEqual(
            by_email["long@example.com"]["errors"],
            ["phone is too long (max 32)."],
        )
        self.assertEqual(by_email["long@example.com"]["phone"], "1" * 32)
        self.assertEqual(
            by_email["formula@example.com"]["errors"],
            ["phone cannot contain a formula."],
        )
        self.assertEqual(by_email["formula@example.com"]["phone"], "")

        aliased = self.paste("name,email,phone number\nAda,ada@example.com,555-010-2000\n")
        self.assertEqual(aliased.status_code, 201, aliased.data)
        self.assertEqual(
            aliased.data["import"]["columnMapping"],
            {"name": 0, "email": 1, "phone": 2},
        )

    def test_explicit_phone_mapping_and_row_phone_edits(self):
        response = self.paste("Person,Address,Contact\nAda,ada@example.com,12\n")
        self.assertEqual(response.status_code, 201, response.data)
        import_id = response.data["import"]["id"]
        self.assertNotIn("phone", response.data["import"]["columnMapping"])

        clashed = self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            {"columnMapping": {"name": "Person", "email": "Address", "phone": "Address"}},
            format="json",
        )
        self.assertEqual(clashed.status_code, 400)
        self.assertEqual(clashed.data["error"], "Each mapped field must use a different column.")

        mapped = self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            {"columnMapping": {"name": "Person", "email": "Address", "phone": "Contact"}},
            format="json",
        )
        self.assertEqual(mapped.status_code, 200, mapped.data)
        self.assertEqual(
            mapped.data["import"]["columnMapping"],
            {"name": 0, "email": 1, "phone": 2},
        )
        self.assertEqual(mapped.data["import"]["summary"]["invalid"], 1)
        rows = self.client.get(f"/events/roster-imports/{import_id}/rows?code={self.event.code}")
        row = rows.data["rows"][0]
        self.assertEqual(row["phone"], "12")
        self.assertEqual(row["errors"], ["phone is invalid."])

        def update_row(**fields):
            updated = self.client.put(
                f"/events/roster-imports/{import_id}?code={self.event.code}",
                {"rowUpdates": [{"id": row["id"], **fields}]},
                format="json",
            )
            self.assertEqual(updated.status_code, 200, updated.data)
            rows = self.client.get(
                f"/events/roster-imports/{import_id}/rows?code={self.event.code}"
            )
            return updated.data["import"]["summary"], rows.data["rows"][0]

        summary, fixed = update_row(phone=" 555.010.2000 ")
        self.assertEqual(summary["valid"], 1)
        self.assertEqual(fixed["phone"], "555.010.2000")
        self.assertEqual(fixed["errors"], [])

        summary, untouched = update_row(group="Team")
        self.assertEqual(summary["valid"], 1)
        self.assertEqual(untouched["phone"], "555.010.2000")

        summary, too_long = update_row(name="", phone="1" * 33)
        self.assertEqual(summary["invalid"], 1)
        self.assertEqual(too_long["phone"], "1" * 32)
        self.assertEqual(
            too_long["errors"],
            ["name is required.", "phone is too long (max 32)."],
        )

        summary, cleared = update_row(name="Ada", phone=None)
        self.assertEqual(summary["valid"], 1)
        self.assertEqual(cleared["phone"], "")
        self.assertEqual(cleared["errors"], [])

    def test_duplicate_rows_compare_phones(self):
        response = self.paste(
            "name,email,phone\n"
            "Alice,alice@example.com,555-010-1000\n"
            "Alice,alice@example.com,555-010-2000\n"
            "Bob,bob@example.com,555-010-3000\n"
            "Bob,bob@example.com,555-010-3000\n"
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(
            response.data["import"]["summary"],
            {"total": 4, "selected": 3, "valid": 1, "invalid": 2, "conflicts": 2},
        )
        rows = self.client.get(
            f"/events/roster-imports/{response.data['import']['id']}/rows?code={self.event.code}"
        )
        statuses = [(row["duplicate"], row["selected"], row["errors"]) for row in rows.data["rows"]]
        self.assertEqual(
            statuses,
            [
                ("conflict", True, ["Conflicting duplicate email."]),
                ("conflict", True, ["Conflicting duplicate email."]),
                ("unique", True, []),
                ("identical", False, []),
            ],
        )

    def test_column_mapping_formula_rejection_and_manual_row_correction(self):
        response = self.paste(
            'Person,Address,Priority\nFormula User,=LOWER("USER@EXAMPLE.COM"),0.2\n'
        )
        self.assertEqual(response.status_code, 201)
        import_id = response.data["import"]["id"]

        mapped = self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            {
                "columnMapping": {"name": "Person", "email": "Address", "weight": 2},
                "defaults": {"included": True},
            },
            format="json",
        )
        self.assertEqual(mapped.status_code, 200)
        rows = self.client.get(f"/events/roster-imports/{import_id}/rows?code={self.event.code}")
        self.assertIn("formula", " ".join(rows.data["rows"][0]["errors"]).lower())

        corrected = self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            {
                "rowUpdates": [
                    {
                        "id": rows.data["rows"][0]["id"],
                        "email": "user@example.com",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(corrected.status_code, 200)
        self.assertEqual(corrected.data["import"]["summary"]["valid"], 1)

    def test_xlsx_requires_sheet_selection_and_rejects_formula_cells(self):
        workbook = Workbook()
        first = workbook.active
        first.title = "Faculty"
        first.append(["name", "email"])
        first.append(["Ada", "ada@example.com"])
        second = workbook.create_sheet("Students")
        second.append(["name", "email"])
        second.append(["Grace", '=LOWER("GRACE@EXAMPLE.COM")'])
        output = io.BytesIO()
        workbook.save(output)

        response = self.client.post(
            f"/events/roster-imports?code={self.event.code}",
            {"file": SimpleUploadedFile("roster.xlsx", output.getvalue())},
            format="multipart",
        )
        self.assertEqual(response.status_code, 201)
        self.assertIsNone(response.data["import"]["selectedWorksheet"])
        self.assertEqual(len(response.data["import"]["worksheets"]), 2)
        import_id = response.data["import"]["id"]

        selected = self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            {
                "worksheet": "Students",
                "columnMapping": {"name": 0, "email": 1},
            },
            format="json",
        )
        self.assertEqual(selected.status_code, 200)
        self.assertEqual(selected.data["import"]["summary"]["invalid"], 1)
        rows = self.client.get(f"/events/roster-imports/{import_id}/rows?code={self.event.code}")
        self.assertIn("formula", " ".join(rows.data["rows"][0]["errors"]).lower())

    def test_upload_size_uncompressed_size_and_column_limits(self):
        oversized = self.client.post(
            f"/events/roster-imports?code={self.event.code}",
            {
                "file": SimpleUploadedFile(
                    "large.csv",
                    b"x" * (5 * 1024 * 1024 + 1),
                )
            },
            format="multipart",
        )
        self.assertEqual(oversized.status_code, 400)
        self.assertIn("5 MiB", oversized.data["error"])

        bomb = io.BytesIO()
        with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("large.bin", b"0" * (25 * 1024 * 1024 + 1))
        uncompressed = self.client.post(
            f"/events/roster-imports?code={self.event.code}",
            {"file": SimpleUploadedFile("large.xlsx", bomb.getvalue())},
            format="multipart",
        )
        self.assertEqual(uncompressed.status_code, 400)
        self.assertIn("25 MiB", uncompressed.data["error"])

        too_wide = self.paste(
            ",".join(f"c{index}" for index in range(51))
            + "\n"
            + ",".join("value" for _ in range(51))
        )
        self.assertEqual(too_wide.status_code, 400)
        self.assertIn("50 columns", too_wide.data["error"])

    def test_import_rejects_more_than_one_thousand_valid_rows(self):
        content = "name,email\n" + "\n".join(
            f"Person {index},person{index}@example.com" for index in range(1001)
        )
        response = self.paste(content)
        self.assertEqual(response.status_code, 400)
        self.assertIn("1000", response.data["error"])
        self.assertEqual(RosterImportBatch.objects.count(), 0)

    def test_preview_flags_blocked_accounts_and_merge_succeeds_once_they_are_deselected(self):
        create_member("inactive@example.com", "Inactive", "Member", is_active=False)
        create_member("unverified@example.com", "Unverified", "Member", contact_verified=False)
        preview = self.paste(
            "name,email\n"
            "Inactive Person,inactive@example.com\n"
            "Unverified Person,unverified@example.com\n"
            "Fresh Person,fresh@example.com\n"
        )
        self.assertEqual(preview.status_code, 201, preview.data)
        import_id = preview.data["import"]["id"]
        self.assertEqual(
            preview.data["import"]["summary"],
            {"total": 3, "selected": 3, "valid": 1, "invalid": 2, "conflicts": 0},
        )

        rows = self.client.get(f"/events/roster-imports/{import_id}/rows?code={self.event.code}")
        self.assertEqual(rows.status_code, 200)
        by_email = {row["email"]: row for row in rows.data["rows"]}
        self.assertFalse(by_email["inactive@example.com"]["valid"])
        self.assertEqual(
            by_email["inactive@example.com"]["errors"],
            ["This email belongs to an inactive account."],
        )
        self.assertFalse(by_email["unverified@example.com"]["valid"])
        self.assertEqual(
            by_email["unverified@example.com"]["errors"],
            ["This email belongs to an unverified full account."],
        )
        self.assertTrue(by_email["fresh@example.com"]["valid"])
        self.assertEqual(by_email["fresh@example.com"]["errors"], [])

        blocked = self.commit(import_id)
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(
            blocked.data["error"],
            "Resolve or deselect invalid roster rows before committing.",
        )
        self.assertEqual(blocked.data["invalidRowCount"], 2)

        deselected = self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            {
                "rowUpdates": [
                    {"id": by_email["inactive@example.com"]["id"], "selected": False},
                    {"id": by_email["unverified@example.com"]["id"], "selected": False},
                ]
            },
            format="json",
        )
        self.assertEqual(deselected.status_code, 200, deselected.data)
        self.assertEqual(
            deselected.data["import"]["summary"],
            {"total": 3, "selected": 1, "valid": 1, "invalid": 0, "conflicts": 0},
        )

        committed = self.commit(import_id)
        self.assertEqual(committed.status_code, 201, committed.data)
        self.assertEqual(committed.data["receipt"]["createdCount"], 1)
        self.assertEqual(
            list(self.event.participants.values_list("participant_name", flat=True)),
            ["Fresh Person"],
        )

    def test_row_email_edits_reflag_and_clear_blocked_accounts(self):
        create_member("inactive@example.com", "Inactive", "Member", is_active=False)
        preview = self.paste("name,email\nFresh Person,fresh@example.com")
        import_id = preview.data["import"]["id"]
        self.assertEqual(preview.data["import"]["summary"]["valid"], 1)
        rows = self.client.get(f"/events/roster-imports/{import_id}/rows?code={self.event.code}")
        row_id = rows.data["rows"][0]["id"]

        reflagged = self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            {"rowUpdates": [{"id": row_id, "email": "Inactive@Example.com"}]},
            format="json",
        )
        self.assertEqual(reflagged.status_code, 200, reflagged.data)
        self.assertEqual(reflagged.data["import"]["summary"]["valid"], 0)
        self.assertEqual(reflagged.data["import"]["summary"]["invalid"], 1)
        rows = self.client.get(f"/events/roster-imports/{import_id}/rows?code={self.event.code}")
        self.assertEqual(rows.data["rows"][0]["email"], "inactive@example.com")
        self.assertFalse(rows.data["rows"][0]["valid"])
        self.assertEqual(
            rows.data["rows"][0]["errors"],
            ["This email belongs to an inactive account."],
        )

        restored = self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            {"rowUpdates": [{"id": row_id, "email": "fresh@example.com"}]},
            format="json",
        )
        self.assertEqual(restored.status_code, 200, restored.data)
        self.assertEqual(restored.data["import"]["summary"]["valid"], 1)
        self.assertEqual(restored.data["import"]["summary"]["invalid"], 0)
        rows = self.client.get(f"/events/roster-imports/{import_id}/rows?code={self.event.code}")
        self.assertTrue(rows.data["rows"][0]["valid"])
        self.assertEqual(rows.data["rows"][0]["errors"], [])

    def test_blocked_rows_do_not_count_toward_the_valid_row_limit(self):
        create_member("person0@example.com", "Blocked", "Member", is_active=False)
        content = "name,email\n" + "\n".join(
            f"Person {index},person{index}@example.com" for index in range(1001)
        )
        response = self.paste(content)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["import"]["summary"]["valid"], 1000)
        self.assertEqual(response.data["import"]["summary"]["invalid"], 1)

    def test_merge_creates_temporary_accounts_reuses_verified_account_and_is_idempotent(self):
        full_member = create_member("verified@example.com", "Verified", "Member")
        preview = self.paste(
            "name,email,group,weight,included\n"
            "Temporary Person,temp@example.com,Guests,0.4,true\n"
            "Known Person,verified@example.com,Faculty,0.9,false\n"
        )
        import_id = preview.data["import"]["id"]
        key = uuid.uuid4()

        committed = self.commit(import_id, key=key)

        self.assertEqual(committed.status_code, 201)
        self.assertFalse(committed.data["idempotent"])
        self.assertEqual(committed.data["autoInvitedCount"], 2)
        self.assertEqual(committed.data["deliveryRequest"]["recipientCount"], 2)
        self.assertEqual(committed.data["receipt"]["createdCount"], 2)
        self.assertEqual(self.event.participants.count(), 2)
        temporary = Participant.objects.select_related("member").get(
            event=self.event,
            member__email="temp@example.com",
        )
        known = Participant.objects.get(event=self.event, member=full_member)
        self.assertEqual(temporary.member.access_level, "temporary")
        self.assertFalse(temporary.member.has_usable_password())
        self.assertEqual(known.participant_name, "Known Person")
        # Imported people start from the event's starting schedule (Available by default).
        for participant in (temporary, known):
            self.assertEqual(participant.availability_inperson, [1, 1])
            self.assertEqual(participant.availability_virtual, [1, 1])
            self.assertFalse(participant.submitted)
        self.assertTrue(
            ContactEmail.objects.filter(
                member=temporary.member,
                email_address="temp@example.com",
                verified=False,
            ).exists()
        )
        self.assertEqual(
            EventInvitation.objects.filter(event=self.event, first_sent_at__isnull=True).count(),
            2,
        )
        self.assertEqual(Weight.objects.get(participant=temporary).weight, 0.4)
        self.assertFalse(Weight.objects.get(participant=known).included)
        self.event.refresh_from_db()
        self.assertEqual(self.event.results_revision, 2)
        snapshot = EventResultSnapshot.objects.get(event=self.event)
        self.assertEqual(snapshot.status, EventResultSnapshot.Status.REFRESHING)
        self.assertEqual(snapshot.requested_revision, 2)
        self.assertEqual(RosterImportBatch.objects.get(pk=import_id).rows.count(), 0)

        replay = self.commit(import_id, key=key)
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(
            replay.data["deliveryRequest"]["id"],
            committed.data["deliveryRequest"]["id"],
        )
        self.assertEqual(replay.data["autoInvitedCount"], 2)
        self.assertEqual(RosterImportReceipt.objects.count(), 1)
        self.assertEqual(self.event.participants.count(), 2)

        conflict = self.commit(
            import_id,
            mode="rebuild",
            key=key,
            confirmation=self.event.code,
        )
        self.assertEqual(conflict.status_code, 409)

    def test_import_seeds_people_busy_when_the_event_starts_busy(self):
        busy_event = Event.objects.create(
            code="ROSTBUSY",
            name="Busy-start event",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            starting_availability="busy",
        )
        UserEvent.objects.create(member=self.organizer, event=busy_event, role="organizer")
        preview = self.paste("name,email\nBusy Person,busy@example.com\n", event=busy_event)
        committed = self.commit(preview.data["import"]["id"], event=busy_event)
        self.assertEqual(committed.status_code, 201, committed.data)
        participant = Participant.objects.get(event=busy_event, member__email="busy@example.com")
        self.assertEqual(participant.availability_inperson, [0, 0])
        self.assertEqual(participant.availability_virtual, [0, 0])

    def test_merge_stores_phones_and_keeps_them_when_the_sheet_has_none(self):
        first = self.paste(
            "name,email,phone\nPerson,person@example.com,555-010-1000\nOther,other@example.com,\n"
        )
        self.assertEqual(self.commit(first.data["import"]["id"]).status_code, 201)
        person = Participant.objects.get(event=self.event, member__email="person@example.com")
        other = Participant.objects.get(event=self.event, member__email="other@example.com")
        self.assertEqual(person.contact_phone, "555-010-1000")
        self.assertEqual(other.contact_phone, "")
        self.assertFalse(person.organizer_managed)
        self.assertEqual(person.version, 1)

        without_column = self.paste(
            "name,email\nPerson,person@example.com\nOther,other@example.com\n"
        )
        kept = self.commit(without_column.data["import"]["id"])
        self.assertEqual(kept.status_code, 201, kept.data)
        self.assertEqual(kept.data["receipt"]["updatedCount"], 2)
        person.refresh_from_db()
        self.assertEqual(person.contact_phone, "555-010-1000")
        self.assertEqual(person.version, 1)

        empty_and_new = self.paste(
            "name,email,phone\nPerson,person@example.com,\nOther,other@example.com,555-010-2000\n"
        )
        self.assertEqual(self.commit(empty_and_new.data["import"]["id"]).status_code, 201)
        person.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual(person.contact_phone, "555-010-1000")
        self.assertEqual(person.version, 1)
        self.assertEqual(other.contact_phone, "555-010-2000")
        self.assertEqual(other.version, 2)

        replaced = self.paste("name,email,phone\nPerson,person@example.com,555-010-9000\n")
        self.assertEqual(self.commit(replaced.data["import"]["id"]).status_code, 201)
        person.refresh_from_db()
        self.assertEqual(person.contact_phone, "555-010-9000")
        self.assertEqual(person.version, 2)

        rebuilt = self.paste("name,email,phone\nRebuilt,rebuilt@example.com,555-010-4000\n")
        response = self.commit(
            rebuilt.data["import"]["id"],
            mode="rebuild",
            confirmation=self.event.code,
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(
            list(self.event.participants.values_list("participant_name", "contact_phone")),
            [("Rebuilt", "555-010-4000")],
        )

    def preview_rows(self, import_id):
        rows = self.client.get(f"/events/roster-imports/{import_id}/rows?code={self.event.code}")
        self.assertEqual(rows.status_code, 200, rows.data)
        return {row["name"]: row for row in rows.data["rows"]}

    def test_rows_without_their_own_email_become_organizer_managed_people(self):
        preview = self.paste(
            "name,email,group,phone\n"
            "Guy No Email,,Faculty,555-010-1000\n"
            "Owner Twin,owner@example.com,,\n"
            "Owner Other,OWNER@example.com,ALL,555-010-2000\n"
            "Ada,ada@example.com,,\n"
        )
        self.assertEqual(preview.status_code, 201, preview.data)
        import_id = preview.data["import"]["id"]
        self.assertEqual(
            preview.data["import"]["summary"],
            {"total": 4, "selected": 4, "valid": 4, "invalid": 0, "conflicts": 0},
        )
        rows = self.preview_rows(import_id)
        self.assertEqual(
            {name: (row["email"], row["organizerManaged"]) for name, row in rows.items()},
            {
                "Guy No Email": ("", True),
                "Owner Twin": ("owner@example.com", True),
                "Owner Other": ("owner@example.com", True),
                "Ada": ("ada@example.com", False),
            },
        )
        self.assertTrue(all(row["valid"] and not row["errors"] for row in rows.values()))

        committed = self.commit(import_id, send_invitations=True)
        self.assertEqual(committed.status_code, 201, committed.data)
        self.assertEqual(committed.data["receipt"]["createdCount"], 4)
        # Only the person with an address of their own is invited.
        self.assertEqual(committed.data["autoInvitedCount"], 1)
        self.assertEqual(
            list(EventInvitation.objects.filter(event=self.event).values_list("email", flat=True)),
            ["ada@example.com"],
        )
        # The organizer never becomes a participant of their own event.
        self.assertFalse(
            Participant.objects.filter(event=self.event, member=self.organizer).exists()
        )
        self.assertEqual(
            list(
                UserEvent.objects.filter(member=self.organizer, event=self.event).values_list(
                    "role", flat=True
                )
            ),
            ["organizer"],
        )
        dashboard = self.client.get("/dashboard/events")
        self.assertEqual([event["code"] for event in dashboard.data["organized"]], ["ROSTER01"])
        self.assertEqual(dashboard.data["participating"], [])

        managed = {
            participant.participant_name: participant
            for participant in Participant.objects.filter(event=self.event, organizer_managed=True)
        }
        self.assertEqual(set(managed), {"Guy No Email", "Owner Twin", "Owner Other"})
        for participant in managed.values():
            self.assertEqual(participant.contact_email, "owner@example.com")
            self.assertEqual(participant.member.email, "")
            self.assertEqual(participant.member.access_level, "temporary")
            self.assertFalse(participant.member.has_usable_password())
            self.assertFalse(participant.member.contact_emails.exists())
            self.assertTrue(
                UserEvent.objects.filter(
                    member=participant.member, event=self.event, role="participant"
                ).exists()
            )
        self.assertEqual(managed["Guy No Email"].contact_phone, "555-010-1000")
        self.assertEqual(
            list(managed["Guy No Email"].groups.values_list("name", flat=True)), ["Faculty"]
        )
        self.assertTrue(managed["Owner Other"].all_groups)
        self.assertTrue(
            Weight.objects.filter(participant=managed["Guy No Email"], weight=1.0).exists()
        )

        roster = self.client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(roster.status_code, 200, roster.data)
        by_name = {row["name"]: row for row in roster.data["participants"]}
        for name in managed:
            self.assertTrue(by_name[name]["organizerManaged"])
            self.assertTrue(by_name[name]["canOrganizerEditAvailability"])
            self.assertEqual(by_name[name]["invitationStatus"], "not_sent")
        self.assertFalse(by_name["Ada"]["organizerManaged"])

    def test_merge_finds_managed_people_again_by_address_and_name(self):
        added = self.client.post(
            f"/events/participants/managed?code={self.event.code}",
            {
                "name": "Guy No Email",
                "email": "",
                "organizerManaged": True,
                "sendInvitation": False,
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(added.status_code, 201, added.data)
        guy = Participant.objects.get(event=self.event, organizer_managed=True)
        self.assertEqual(guy.contact_email, "owner@example.com")
        hidden = Participant.objects.create(
            event=self.event,
            member=create_member("hidden-shell@example.com", "Hidden", "Shell"),
            participant_name="Hidden Shell",
            hidden=True,
        )
        hidden.member.contact_emails.all().delete()
        hidden.member.email = ""
        hidden.member.save(update_fields=["email"])
        hidden.organizer_managed = True
        hidden.contact_email = "owner@example.com"
        hidden.save(update_fields=["organizer_managed", "contact_email"])
        member_count = type(self.organizer).objects.count()

        preview = self.paste(
            "name,email,group,phone\n"
            "guy no email,,Team 3,555-010-3000\n"
            "HIDDEN SHELL,owner@example.com,,\n"
        )
        self.assertEqual(preview.status_code, 201, preview.data)
        committed = self.commit(preview.data["import"]["id"], send_invitations=True)
        self.assertEqual(committed.status_code, 201, committed.data)
        self.assertEqual(committed.data["receipt"]["createdCount"], 0)
        self.assertEqual(committed.data["receipt"]["updatedCount"], 2)
        # Restoring someone without an email of their own never invites them.
        self.assertEqual(committed.data["autoInvitedCount"], 0)
        self.assertFalse(EventInvitation.objects.filter(event=self.event).exists())
        self.assertEqual(type(self.organizer).objects.count(), member_count)

        guy.refresh_from_db()
        self.assertEqual(guy.participant_name, "guy no email")
        self.assertEqual(guy.contact_phone, "555-010-3000")
        self.assertEqual(list(guy.groups.values_list("name", flat=True)), ["Team 3"])
        self.assertEqual(guy.version, 2)
        hidden.refresh_from_db()
        self.assertFalse(hidden.hidden)
        self.assertEqual(hidden.participant_name, "HIDDEN SHELL")
        self.assertEqual(Participant.objects.filter(event=self.event).count(), 2)

        # A later cell only adds a group, which alone bumps the version.
        regroup = self.paste("name,email,group\nguy no email,,Team 3; Faculty\n")
        self.assertEqual(self.commit(regroup.data["import"]["id"]).status_code, 201)
        guy.refresh_from_db()
        self.assertEqual(sorted(guy.groups.values_list("name", flat=True)), ["Faculty", "Team 3"])
        self.assertEqual(guy.version, 3)

    def test_rows_for_people_without_an_email_are_deduplicated_by_name(self):
        preview = self.paste(
            "name,email,group\nGuy,,A\nGuy,owner@example.com,A\nPat,,A\npat,,B\n,,C\n"
        )
        self.assertEqual(preview.status_code, 201, preview.data)
        self.assertEqual(
            preview.data["import"]["summary"],
            {"total": 5, "selected": 4, "valid": 1, "invalid": 3, "conflicts": 2},
        )
        rows = self.client.get(
            f"/events/roster-imports/{preview.data['import']['id']}/rows?code={self.event.code}"
        ).data["rows"]
        # Blank and own-address spellings of one person are one identical row.
        self.assertEqual(
            [(row["name"], row["duplicate"], row["selected"], row["errors"]) for row in rows],
            [
                ("Guy", "unique", True, []),
                ("Guy", "identical", False, []),
                ("Pat", "conflict", True, ["Conflicting duplicate name."]),
                ("pat", "conflict", True, ["Conflicting duplicate name."]),
                ("", "unique", True, ["name is required."]),
            ],
        )

    def test_rows_without_an_email_need_a_verified_address_of_the_organizer(self):
        ContactEmail.objects.create(
            member=self.organizer,
            email_address="alias@example.com",
            email_type="secondary",
            verified=False,
        )
        preview = self.paste("name,email\nAlias Person,alias@example.com\n")
        self.assertEqual(preview.status_code, 201, preview.data)
        rows = self.preview_rows(preview.data["import"]["id"])
        self.assertTrue(rows["Alias Person"]["organizerManaged"])
        self.assertEqual(
            rows["Alias Person"]["errors"],
            ["Verify this address on your account before using it for someone without an email."],
        )

        ContactEmail.objects.filter(member=self.organizer).update(verified=False)
        preview = self.paste("name,email\nGuy No Email,\n")
        self.assertEqual(preview.status_code, 201, preview.data)
        rows = self.preview_rows(preview.data["import"]["id"])
        self.assertFalse(rows["Guy No Email"]["organizerManaged"])
        self.assertEqual(rows["Guy No Email"]["errors"], ["email is required."])

    def test_commit_refuses_rows_whose_address_changed_since_the_preview(self):
        for pasted in ("name,email\nGuy No Email,\n", "name,email\nOwner Row,owner@example.com\n"):
            with self.subTest(pasted=pasted):
                ContactEmail.objects.filter(member=self.organizer).update(verified=True)
                preview = self.paste(pasted)
                self.assertEqual(preview.data["import"]["summary"]["valid"], 1)
                ContactEmail.objects.filter(member=self.organizer).update(verified=False)
                refused = self.commit(preview.data["import"]["id"])
                self.assertEqual(refused.status_code, 409, refused.data)
                self.assertEqual(
                    refused.data["error"],
                    "Your email addresses changed after this preview was made. "
                    "Review the rows again before importing.",
                )
                self.assertEqual(
                    RosterImportBatch.objects.get(pk=preview.data["import"]["id"]).status,
                    RosterImportBatch.Status.PREVIEW,
                )
        self.assertFalse(Participant.objects.filter(event=self.event).exists())

        alias = ContactEmail.objects.create(
            member=self.organizer,
            email_address="alias@example.com",
            email_type="secondary",
            verified=True,
        )
        ContactEmail.objects.filter(member=self.organizer).update(verified=True)
        preview = self.paste("name,email\nGuy,\nGuy,alias@example.com\n")
        self.assertEqual(preview.data["import"]["summary"]["valid"], 2)
        # The blank row now files under the alias, where the other row already is.
        ContactEmail.objects.filter(member=self.organizer).exclude(pk=alias.pk).update(
            email_type="secondary"
        )
        ContactEmail.objects.filter(pk=alias.pk).update(email_type="primary")
        clashed = self.commit(preview.data["import"]["id"])
        self.assertEqual(clashed.status_code, 409, clashed.data)
        self.assertEqual(
            clashed.data["error"], "Two selected rows describe the same person without an email."
        )
        self.assertFalse(Participant.objects.filter(event=self.event).exists())

    def test_rebuild_replaces_managed_people_with_the_imported_ones(self):
        first = self.paste("name,email\nGuy No Email,\n")
        self.assertEqual(self.commit(first.data["import"]["id"]).status_code, 201)
        old_member = Participant.objects.get(event=self.event).member_id
        rebuilt = self.paste("name,email\nGuy No Email,\n")
        response = self.commit(
            rebuilt.data["import"]["id"], mode="rebuild", confirmation=self.event.code
        )
        self.assertEqual(response.status_code, 201, response.data)
        participant = Participant.objects.get(event=self.event)
        self.assertTrue(participant.organizer_managed)
        self.assertNotEqual(participant.member_id, old_member)
        self.assertFalse(type(self.organizer).objects.filter(pk=old_member).exists())

    def test_commit_without_invitations_adds_people_and_replays_only_with_the_same_flag(self):
        full_member = create_member("verified@example.com", "Verified", "Member")
        preview = self.paste(
            "name,email\nTemporary Person,temp@example.com\nKnown Person,verified@example.com\n"
        )
        import_id = preview.data["import"]["id"]
        key = uuid.uuid4()

        for value in ["false", 0]:
            with self.subTest(value=value):
                invalid = self.commit(import_id, key=key, send_invitations=value)
                self.assertEqual(invalid.status_code, 400, invalid.data)
                self.assertEqual(invalid.data["error"], "sendInvitations must be a boolean.")
        self.assertEqual(self.event.participants.count(), 0)

        committed = self.commit(import_id, key=key, send_invitations=False)
        self.assertEqual(committed.status_code, 201, committed.data)
        self.assertFalse(committed.data["idempotent"])
        self.assertEqual(committed.data["autoInvitedCount"], 0)
        self.assertIsNone(committed.data["deliveryRequest"])
        self.assertEqual(committed.data["receipt"]["createdCount"], 2)
        self.assertEqual(committed.data["receipt"]["updatedCount"], 0)
        self.assertEqual(self.event.participants.count(), 2)
        self.assertTrue(Participant.objects.filter(event=self.event, member=full_member).exists())
        self.assertEqual(
            EventInvitation.objects.filter(event=self.event, first_sent_at__isnull=True).count(),
            2,
        )
        self.assertFalse(EmailDeliveryJob.objects.exists())
        self.assertFalse(EmailDeliveryRequest.objects.exists())
        self.assertEqual(RosterImportBatch.objects.get(pk=import_id).rows.count(), 0)
        roster = self.client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(roster.status_code, 200, roster.data)
        self.assertEqual(
            {item["invitationStatus"] for item in roster.data["participants"]},
            {"not_sent"},
        )
        self.assertIsNone(roster.data["latestDeliveryRequest"])

        replay = self.commit(import_id, key=key, send_invitations=False)
        self.assertEqual(replay.status_code, 200, replay.data)
        self.assertTrue(replay.data["idempotent"])
        self.assertEqual(replay.data["autoInvitedCount"], 0)
        self.assertIsNone(replay.data["deliveryRequest"])
        self.assertEqual(replay.data["receipt"]["id"], committed.data["receipt"]["id"])
        self.assertEqual(RosterImportReceipt.objects.count(), 1)
        self.assertFalse(EmailDeliveryJob.objects.exists())

        for send_invitations in [True, None]:
            with self.subTest(send_invitations=send_invitations):
                conflict = self.commit(import_id, key=key, send_invitations=send_invitations)
                self.assertEqual(conflict.status_code, 409, conflict.data)
                self.assertEqual(
                    conflict.data["error"],
                    "This idempotency key was already used for a different import.",
                )
        self.assertEqual(RosterImportReceipt.objects.count(), 1)
        self.assertFalse(EmailDeliveryJob.objects.exists())

        rebuild = self.paste("name,email\nRebuilt Person,rebuilt@example.com")
        rebuilt = self.commit(
            rebuild.data["import"]["id"],
            mode="rebuild",
            confirmation=self.event.code,
            send_invitations=False,
        )
        self.assertEqual(rebuilt.status_code, 201, rebuilt.data)
        self.assertEqual(rebuilt.data["autoInvitedCount"], 0)
        self.assertIsNone(rebuilt.data["deliveryRequest"])
        self.assertEqual(
            list(self.event.participants.values_list("participant_name", flat=True)),
            ["Rebuilt Person"],
        )
        rebuilt_invitation = EventInvitation.objects.get(event=self.event)
        self.assertEqual(rebuilt_invitation.email, "rebuilt@example.com")
        self.assertIsNone(rebuilt_invitation.first_sent_at)
        self.assertFalse(EmailDeliveryJob.objects.exists())
        reminders = self.client.post(
            f"/events/reminders?code={self.event.code}",
            {"idempotencyKey": str(uuid.uuid4())},
            format="json",
        )
        self.assertEqual(reminders.status_code, 202, reminders.data)
        self.assertEqual(reminders.data["recipientCount"], 0)
        self.assertFalse(EmailDeliveryJob.objects.exists())

    def test_import_invitation_enqueue_failure_rolls_back_the_full_commit(self):
        email = "import-rollback@example.com"
        preview = self.paste(f"name,email\nRollback Person,{email}")
        import_id = preview.data["import"]["id"]

        with (
            patch(
                "apps.scheduling.services.invitations.delivery._enqueue_invitation_job",
                side_effect=RuntimeError("queue unavailable"),
            ),
            self.assertRaisesMessage(RuntimeError, "queue unavailable"),
        ):
            self.commit(import_id)

        batch = RosterImportBatch.objects.get(pk=import_id)
        self.assertEqual(batch.status, RosterImportBatch.Status.PREVIEW)
        self.assertTrue(batch.rows.exists())
        self.assertFalse(ContactEmail.objects.filter(email_address=email).exists())
        self.assertFalse(Participant.objects.filter(event=self.event).exists())
        self.assertFalse(EventInvitation.objects.filter(event=self.event).exists())
        self.assertFalse(EmailDeliveryRequest.objects.filter(event=self.event).exists())
        self.assertFalse(EmailDeliveryJob.objects.filter(event=self.event).exists())
        self.assertFalse(RosterImportReceipt.objects.filter(event=self.event).exists())

    def test_merge_preserves_existing_schedule_and_rebuild_replaces_roster(self):
        first = self.paste("name,email,weight\nPerson,person@example.com,1")
        self.assertEqual(self.commit(first.data["import"]["id"]).status_code, 201)
        participant = Participant.objects.get(event=self.event)
        participant.availability_inperson = [1, 0]
        participant.submitted = True
        participant.save(update_fields=["availability_inperson", "submitted", "updated_at"])

        second = self.paste("name,email,weight\nRenamed,person@example.com,0.2")
        merged = self.commit(second.data["import"]["id"])
        self.assertEqual(merged.status_code, 201)
        participant.refresh_from_db()
        self.assertEqual(participant.participant_name, "Renamed")
        self.assertEqual(participant.availability_inperson, [1, 0])
        self.assertTrue(participant.submitted)

        invitation = EventInvitation.objects.get(event=self.event)
        TemporaryEventSession.objects.create(
            member=participant.member,
            participant=participant,
            invitation=invitation,
            secret_hash="a" * 64,
            expires_at=timezone.now() + timedelta(days=1),
        )
        challenge = EmailAuthChallenge.objects.create(
            member=participant.member,
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
            target_email=participant.member.email,
            code_hash="challenge-hash",
            expires_at=timezone.now() + timedelta(minutes=10),
        )
        challenge_job, _created = enqueue_email_job(
            idempotency_key="rebuild-auth-challenge",
            message_type=EmailMessageLog.MessageType.VERIFICATION,
            recipient=participant.member.email,
            subject="Temporary access",
            body="code",
            message_id="<rebuild-auth-challenge@releviz.local>",
            member=participant.member,
            auth_challenge=challenge,
        )
        invitation_job, _created = enqueue_email_job(
            idempotency_key="rebuild-pending-invitation",
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient=participant.member.email,
            subject="Invitation",
            body="invite",
            message_id="<rebuild-pending-invitation@releviz.local>",
            event=self.event,
            invitation=invitation,
        )
        stale_request = EmailDeliveryRequest.objects.create(
            event=self.event,
            requested_by=self.organizer,
            operation=EmailDeliveryRequest.Operation.INVITATION,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="a" * 64,
            recipient_count=1,
            created_job_count=1,
        )
        stale_request.jobs.add(invitation_job)
        cancellation_job, _created = enqueue_email_job(
            idempotency_key="final-cancellation:rebuild:1:person@example.com",
            message_type=EmailMessageLog.MessageType.FINAL_CANCELLATION,
            recipient=participant.member.email,
            subject="Canceled",
            body="cancel",
            message_id="<rebuild-final-cancellation@releviz.local>",
            event=self.event,
        )
        cancellation_request = EmailDeliveryRequest.objects.create(
            event=self.event,
            requested_by=self.organizer,
            operation=EmailDeliveryRequest.Operation.FINAL_CANCELLATION,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="b" * 64,
            recipient_count=1,
            created_job_count=1,
        )
        cancellation_request.jobs.add(cancellation_job)
        stale_bulk_receipt = RosterBulkUpdateReceipt.objects.create(
            event=self.event,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="c" * 64,
            matched_count=1,
            updated_count=1,
            results_revision=self.event.results_revision,
        )
        replacement = self.paste("name,email\nReplacement,replacement@example.com")
        self.assertEqual(replacement.status_code, 201, replacement.data)
        import_id = replacement.data["import"]["id"]

        wrong_confirmation = self.commit(
            import_id,
            mode="rebuild",
            confirmation="WRONG",
        )
        self.assertEqual(wrong_confirmation.status_code, 400)

        processing_token = uuid.uuid4()
        invitation_job.status = EmailDeliveryJob.Status.PROCESSING
        invitation_job.attempt_count = 1
        invitation_job.locked_at = timezone.now()
        invitation_job.lock_token = processing_token
        invitation_job.save(
            update_fields=[
                "status",
                "attempt_count",
                "locked_at",
                "lock_token",
                "updated_at",
            ]
        )
        blocked = self.commit(
            import_id,
            mode="rebuild",
            confirmation=self.event.code,
        )
        self.assertEqual(blocked.status_code, 409)
        self.assertIn("in-progress email deliveries", blocked.data["error"])
        invitation_job.refresh_from_db()
        challenge.refresh_from_db()
        self.event.refresh_from_db()
        self.assertEqual(invitation_job.status, EmailDeliveryJob.Status.PROCESSING)
        self.assertEqual(invitation_job.lock_token, processing_token)
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.PENDING)
        self.assertEqual(self.event.status, Event.Status.ACTIVE)
        self.assertTrue(TemporaryEventSession.objects.filter(participant=participant).exists())
        self.assertTrue(Participant.objects.filter(pk=participant.pk).exists())

        invitation_job.status = EmailDeliveryJob.Status.RETRY
        invitation_job.locked_at = None
        invitation_job.lock_token = None
        invitation_job.save(
            update_fields=[
                "status",
                "locked_at",
                "lock_token",
                "updated_at",
            ]
        )
        rebuilt = self.commit(
            import_id,
            mode="rebuild",
            confirmation=self.event.code.lower(),
        )
        self.assertEqual(rebuilt.status_code, 201)
        self.event.refresh_from_db()
        self.assertEqual(self.event.status, Event.Status.ACTIVE)
        self.assertIsNone(self.event.closed_at)
        self.assertEqual(
            list(self.event.participants.values_list("participant_name", flat=True)),
            ["Replacement"],
        )
        self.assertFalse(TemporaryEventSession.objects.exists())
        self.assertFalse(
            UserEvent.objects.filter(event=self.event, member=participant.member).exists()
        )
        challenge.refresh_from_db()
        challenge_job.refresh_from_db()
        invitation_job.refresh_from_db()
        cancellation_job.refresh_from_db()
        self.assertEqual(challenge.status, EmailAuthChallenge.Status.EXPIRED)
        self.assertEqual(challenge_job.status, EmailDeliveryJob.Status.CANCELED)
        self.assertEqual(invitation_job.status, EmailDeliveryJob.Status.CANCELED)
        self.assertEqual(cancellation_job.status, EmailDeliveryJob.Status.PENDING)
        self.assertFalse(EmailDeliveryRequest.objects.filter(pk=stale_request.pk).exists())
        self.assertTrue(EmailDeliveryRequest.objects.filter(pk=cancellation_request.pk).exists())
        self.assertFalse(RosterBulkUpdateReceipt.objects.filter(pk=stale_bulk_receipt.pk).exists())

    def test_expiry_cancel_and_organizer_only_access_scrub_preview_rows(self):
        preview = self.paste("name,email\nPerson,person@example.com")
        import_id = preview.data["import"]["id"]
        batch = RosterImportBatch.objects.get(pk=import_id)
        batch.expires_at = timezone.now() - timedelta(seconds=1)
        batch.save(update_fields=["expires_at", "updated_at"])

        expired = self.client.get(f"/events/roster-imports/{import_id}/rows?code={self.event.code}")
        self.assertEqual(expired.status_code, 410)
        batch.refresh_from_db()
        self.assertEqual(batch.status, RosterImportBatch.Status.EXPIRED)
        self.assertEqual(batch.rows.count(), 0)

        fresh = self.paste("name,email\nPerson,two@example.com")
        fresh_id = fresh.data["import"]["id"]
        canceled = self.client.delete(f"/events/roster-imports/{fresh_id}?code={self.event.code}")
        self.assertEqual(canceled.status_code, 200)
        self.assertEqual(canceled.data["status"], "canceled")

        self.authenticate(self.outsider)
        forbidden = self.client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(forbidden.status_code, 403)
        self.assertIn("no-store", forbidden["Cache-Control"])

    def test_paginated_roster_schedule_and_patch_and_bulk_updates(self):
        full_member = create_member("full@example.com", "Full", "Member")
        preview = self.paste(
            "name,email,group\n"
            "One,one@example.com,A\n"
            "Two,two@example.com,A\n"
            "Full User,full@example.com,B\n"
        )
        self.assertEqual(self.commit(preview.data["import"]["id"]).status_code, 201)

        # Groups are rows: the import created one per distinct name, and the
        # stats entries carry the row's pk as ``id``.
        group_a = ParticipantGroup.objects.get(event=self.event, name="A")
        group_b = ParticipantGroup.objects.get(event=self.event, name="B")
        roster = self.client.get(f"/events/roster?code={self.event.code}&pageSize=2")
        self.assertEqual(roster.status_code, 200)
        self.assertEqual(len(roster.data["participants"]), 2)
        self.assertEqual(roster.data["pagination"]["total"], 3)
        self.assertEqual(
            roster.data["stats"]["groups"],
            [
                {"id": group_a.pk, "name": "A", "count": 2, "weight": 1.0, "included": True},
                {"id": group_b.pk, "name": "B", "count": 1, "weight": 1.0, "included": True},
            ],
        )
        self.assertNotIn("availabilityInperson", roster.data["participants"][0])
        self.assertEqual(roster.data["participants"][0]["group"], "A")
        self.assertEqual(
            roster.data["participants"][0]["groups"], [{"id": group_a.pk, "name": "A"}]
        )
        self.assertFalse(roster.data["participants"][0]["allGroups"])

        full_participant = Participant.objects.get(event=self.event, member=full_member)
        schedule = self.client.get(
            f"/events/roster/{full_participant.pk}/schedule?code={self.event.code}"
        )
        self.assertEqual(schedule.status_code, 200)
        self.assertEqual(schedule.data["participant"]["memberId"], str(full_member.pk))
        # Imported and untouched: the organizer may enter it until the person responds.
        self.assertTrue(schedule.data["participant"]["canOrganizerEditAvailability"])
        self.assertIn("availabilityInperson", schedule.data["schedule"])

        patched = self.client.patch(
            f"/events/roster/{full_participant.pk}?code={self.event.code}",
            {
                "expectedVersion": full_participant.version,
                "weight": 0.3,
                "included": False,
                "group": "C",
            },
            format="json",
        )
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.data["participant"]["weight"], 0.3)
        self.assertFalse(patched.data["participant"]["included"])
        self.assertEqual(patched.data["participant"]["group"], "C")
        # The cell created group C; B is emptied but stays as a row.
        group_c = ParticipantGroup.objects.get(event=self.event, name="C")
        self.assertEqual(patched.data["participant"]["groups"], [{"id": group_c.pk, "name": "C"}])
        self.assertEqual(
            patched.data["groups"],
            [
                {"id": group_a.pk, "name": "A", "count": 2, "weight": 1.0, "included": True},
                {"id": group_b.pk, "name": "B", "count": 0, "weight": None, "included": None},
                {"id": group_c.pk, "name": "C", "count": 1, "weight": 0.3, "included": False},
            ],
        )
        stale = self.client.patch(
            f"/events/roster/{full_participant.pk}?code={self.event.code}",
            {"expectedVersion": full_participant.version, "weight": 0.8},
            format="json",
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.data["error"], "The participant changed in another session.")
        # The payload carries the row as it now stands so the organizer can
        # reload it without refetching the roster.
        self.assertEqual(stale.data["participant"]["id"], str(full_participant.pk))
        self.assertEqual(stale.data["participant"]["weight"], 0.3)
        self.assertFalse(stale.data["participant"]["included"])
        self.assertEqual(stale.data["participant"]["group"], "C")
        self.assertEqual(
            stale.data["participant"]["version"],
            patched.data["participant"]["version"],
        )

        bulk = self.client.patch(
            f"/events/roster/bulk?code={self.event.code}",
            {
                "group": "A",
                "updates": {"weight": 0.6, "included": False},
                "idempotencyKey": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(bulk.status_code, 200)
        self.assertEqual(bulk.data["matchedCount"], 2)
        self.assertEqual(
            Weight.objects.filter(event=self.event, weight=0.6, included=False).count(),
            2,
        )
        # Group stats report the shared weight, or null once members differ.
        regrouped = self.client.get(f"/events/roster?code={self.event.code}")
        self.assertEqual(regrouped.status_code, 200)
        self.assertEqual(
            regrouped.data["stats"]["groups"],
            [
                {"id": group_a.pk, "name": "A", "count": 2, "weight": 0.6, "included": False},
                {"id": group_b.pk, "name": "B", "count": 0, "weight": None, "included": None},
                {"id": group_c.pk, "name": "C", "count": 1, "weight": 0.3, "included": False},
            ],
        )
        one = Participant.objects.get(event=self.event, participant_name="One")
        split = self.client.patch(
            f"/events/roster/{one.pk}?code={self.event.code}",
            {"expectedVersion": one.version, "weight": 0.9},
            format="json",
        )
        self.assertEqual(split.status_code, 200)
        # Group stats describe the whole roster even while a filter is active.
        mixed = self.client.get(f"/events/roster?code={self.event.code}&group=C")
        self.assertEqual(mixed.data["pagination"]["total"], 1)
        self.assertEqual(
            mixed.data["stats"]["groups"],
            [
                {"id": group_a.pk, "name": "A", "count": 2, "weight": None, "included": False},
                {"id": group_b.pk, "name": "B", "count": 0, "weight": None, "included": None},
                {"id": group_c.pk, "name": "C", "count": 1, "weight": 0.3, "included": False},
            ],
        )
