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

    def commit(self, import_id, *, mode="merge", key=None, confirmation=None, event=None):
        event = event or self.event
        payload = {
            "mode": mode,
            "idempotencyKey": str(key or uuid.uuid4()),
        }
        if confirmation is not None:
            payload["confirmationCode"] = confirmation
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

        roster = self.client.get(f"/events/roster?code={self.event.code}&pageSize=2")
        self.assertEqual(roster.status_code, 200)
        self.assertEqual(len(roster.data["participants"]), 2)
        self.assertEqual(roster.data["pagination"]["total"], 3)
        self.assertEqual(
            roster.data["stats"]["groups"],
            [
                {"name": "A", "count": 2},
                {"name": "B", "count": 1},
            ],
        )
        self.assertNotIn("availabilityInperson", roster.data["participants"][0])

        full_participant = Participant.objects.get(event=self.event, member=full_member)
        schedule = self.client.get(
            f"/events/roster/{full_participant.pk}/schedule?code={self.event.code}"
        )
        self.assertEqual(schedule.status_code, 200)
        self.assertEqual(schedule.data["participant"]["memberId"], str(full_member.pk))
        self.assertFalse(schedule.data["participant"]["canOrganizerEditAvailability"])
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
        stale = self.client.patch(
            f"/events/roster/{full_participant.pk}?code={self.event.code}",
            {"expectedVersion": full_participant.version, "weight": 0.8},
            format="json",
        )
        self.assertEqual(stale.status_code, 409)

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
