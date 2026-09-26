"""Commit a roster import preview into the event roster."""

import hashlib
import json
import uuid

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.scheduling.models import (
    Event,
    EventInvitation,
    EventResultSnapshot,
    Participant,
    RosterImportBatch,
    RosterImportReceipt,
    RosterImportRow,
    TemporaryEventSession,
    UserEvent,
    Weight,
)
from apps.scheduling.services.availability import default_availability
from apps.scheduling.services.events.lifecycle import response_write_error
from apps.scheduling.services.invitations.addresses import organizer_addresses
from apps.scheduling.services.invitations.delivery import upsert_and_send_invitations
from apps.scheduling.services.invitations.errors import EventEmailRequestError
from apps.scheduling.services.managed_members import delete_organizer_managed_members
from apps.scheduling.services.roster_groups import add_memberships, parse_group_cell

from .batches import require_preview, scrub_batch
from .errors import RosterImportError
from .limits import MAX_ROSTER_ROWS
from .normalization import managed_key


def _fingerprint(payload: dict) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _resolve_members(rows: list[RosterImportRow]):
    emails = [row.email for row in rows]
    Member = get_user_model()
    initial_contacts = list(
        ContactEmail.objects.filter(email_address__in=emails).only(
            "pk",
            "email_address",
            "member_id",
        )
    )
    initial_member_ids = sorted(
        {contact.member_id for contact in initial_contacts if contact.member_id is not None},
        key=str,
    )
    locked_members = {
        member.pk: member
        for member in Member.objects.select_for_update()
        .filter(pk__in=initial_member_ids)
        .order_by("pk")
    }
    locked_contacts = list(
        ContactEmail.objects.select_for_update()
        .filter(email_address__in=emails)
        .order_by("email_address")
    )
    if any(
        contact.member_id is not None and contact.member_id not in locked_members
        for contact in locked_contacts
    ):
        raise RosterImportError(
            "An account changed while participants were being imported; retry the commit.",
            status_code=409,
        )
    contacts = {}
    for contact in locked_contacts:
        if contact.member_id is not None:
            contact.member = locked_members[contact.member_id]
        contacts[contact.email_address.lower()] = contact
    new_members = []
    new_contacts = []
    orphan_contacts = []
    resolved = {}
    names = {row.email: row.name for row in rows}

    for email in emails:
        contact = contacts.get(email)
        if contact is not None and contact.member_id is not None:
            member = contact.member
            if not member.is_active:
                raise RosterImportError(
                    "An imported email belongs to an inactive account.",
                    status_code=409,
                )
            if getattr(member, "access_level", "full") == "full" and not contact.verified:
                raise RosterImportError(
                    "An imported email belongs to an unverified full account.",
                    status_code=409,
                )
            resolved[email] = member
            continue

        member = Member(
            email=email,
            first_name=names[email],
            is_active=True,
            access_level=Member.AccessLevel.TEMPORARY,
        )
        member.set_unusable_password()
        new_members.append(member)
        resolved[email] = member
        if contact is None:
            new_contacts.append(
                ContactEmail(
                    member=member,
                    email_address=email,
                    email_type="primary",
                    verified=False,
                )
            )
        else:
            contact.member = member
            contact.email_type = "primary"
            contact.verified = False
            orphan_contacts.append(contact)

    if new_members:
        Member.objects.bulk_create(new_members)
    if new_contacts:
        ContactEmail.objects.bulk_create(new_contacts)
    if orphan_contacts:
        ContactEmail.objects.bulk_update(
            orphan_contacts,
            ["member", "email_type", "verified", "updated_at"],
        )
    member_ids = [member.pk for member in resolved.values()]
    if len(set(member_ids)) != len(member_ids):
        raise RosterImportError(
            "Two imported email addresses resolve to the same account.",
            status_code=409,
        )
    return resolved


def _rebuild_event_roster(event: Event, now) -> None:
    # Keep the destructive path in the same lock order as account upgrades:
    # member/contact (resolved by the caller), participant, challenge/job,
    # session, then invitation. Schedule writes that already own one
    # participant can finish without forming Participant <-> Invitation cycles.
    participants = list(event.participants.select_for_update().order_by("pk"))
    participant_member_ids = [participant.member_id for participant in participants]
    challenges = list(
        EmailAuthChallenge.objects.select_for_update()
        .filter(
            purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
            member_id__in=participant_member_ids,
        )
        .order_by("pk")
    )
    challenge_ids = [challenge.pk for challenge in challenges]
    jobs = list(
        EmailDeliveryJob.objects.select_for_update()
        .filter(Q(event=event) | Q(auth_challenge_id__in=challenge_ids))
        .order_by("pk")
    )
    if any(job.status == EmailDeliveryJob.Status.PROCESSING for job in jobs):
        raise RosterImportError(
            "Wait for in-progress email deliveries to finish before rebuilding the participant list.",
            status_code=409,
        )
    if challenge_ids:
        EmailAuthChallenge.objects.filter(
            pk__in=challenge_ids,
            status=EmailAuthChallenge.Status.PENDING,
        ).update(status=EmailAuthChallenge.Status.EXPIRED, updated_at=now)
        EmailDeliveryJob.objects.filter(
            auth_challenge_id__in=challenge_ids,
            status__in=[
                EmailDeliveryJob.Status.PENDING,
                EmailDeliveryJob.Status.RETRY,
            ],
        ).update(
            status=EmailDeliveryJob.Status.CANCELED,
            last_error="The participant list was rebuilt.",
            locked_at=None,
            lock_token=None,
            updated_at=now,
        )
    sessions = list(
        TemporaryEventSession.objects.select_for_update()
        .filter(participant__event=event, revoked_at__isnull=True)
        .order_by("pk")
    )
    if sessions:
        TemporaryEventSession.objects.filter(pk__in=[session.pk for session in sessions]).update(
            revoked_at=now,
            updated_at=now,
        )
    EmailDeliveryJob.objects.filter(
        event=event,
        status__in=[
            EmailDeliveryJob.Status.PENDING,
            EmailDeliveryJob.Status.RETRY,
        ],
    ).exclude(message_type=EmailMessageLog.MessageType.FINAL_CANCELLATION).update(
        status=EmailDeliveryJob.Status.CANCELED,
        locked_at=None,
        lock_token=None,
        updated_at=now,
    )
    event.user_events.filter(role="participant").delete()
    event.roster_bulk_update_receipts.all().delete()
    event.email_delivery_requests.exclude(
        operation="final_cancellation",
    ).delete()
    invitations = list(event.invitations.select_for_update().order_by("pk"))
    if invitations:
        EventInvitation.objects.filter(
            pk__in=[invitation.pk for invitation in invitations]
        ).delete()
    if participants:
        Participant.objects.filter(pk__in=[participant.pk for participant in participants]).delete()
    delete_organizer_managed_members(
        [participant.member_id for participant in participants if participant.organizer_managed]
    )
    event.participant_groups.all().delete()
    event.version += 1


def _managed_participants(event: Event) -> dict:
    """The event's organizer-managed people keyed by filing address and name."""

    managed = {}
    for participant in (
        Participant.objects.select_for_update()
        .filter(event=event, organizer_managed=True)
        .order_by("pk")
    ):
        managed.setdefault(
            managed_key(participant.contact_email, participant.participant_name), participant
        )
    return managed


def _managed_member(name: str):
    """An identity-less member for a person with no email of their own."""

    Member = get_user_model()
    member = Member(
        email="",
        first_name=name,
        is_active=True,
        access_level=Member.AccessLevel.TEMPORARY,
    )
    member.set_unusable_password()
    return member


def _write_roster(
    event: Event,
    organizer,
    rows: list[RosterImportRow],
    *,
    members: dict,
    addresses,
):
    # A row under a blank email or one of the organizer's own addresses is a
    # person the organizer manages: a fresh identity-less member, found again
    # by filing address and name, that never gets an invitation. ``members``
    # resolves every other row's email to its account.
    account_rows = [row for row in rows if not addresses.manages(row.email)]
    member_ids = [members[row.email].pk for row in account_rows]
    existing = {
        participant.member_id: participant
        for participant in Participant.objects.select_for_update().filter(
            event=event,
            member_id__in=member_ids,
        )
    }
    managed = _managed_participants(event)
    managed_keys = [
        managed_key(addresses.contact_for(row.email), row.name)
        for row in rows
        if addresses.manages(row.email)
    ]
    if len(set(managed_keys)) != len(managed_keys):
        raise RosterImportError(
            "Two selected rows describe the same person without an email.",
            status_code=409,
        )
    current_member_ids = set(
        Participant.objects.filter(event=event).values_list("member_id", flat=True)
    )
    new_managed_count = sum(key not in managed for key in managed_keys)
    if len(current_member_ids | set(member_ids)) + new_managed_count > MAX_ROSTER_ROWS:
        raise RosterImportError(
            f"An event can have at most {MAX_ROSTER_ROWS} participants.",
            status_code=409,
        )
    roster_emails = {row.email for row in account_rows}
    current_invitation_emails = set(event.invitations.values_list("email", flat=True))
    if len(current_invitation_emails | roster_emails) > MAX_ROSTER_ROWS:
        raise RosterImportError(
            f"An event can have at most {MAX_ROSTER_ROWS} invitation recipients.",
            status_code=409,
        )

    new_members = []
    new_participants = []
    changed_participants = []
    invitation_emails = []
    # The roster entry behind each row, in row order.
    row_participants = []
    # (participant, (all_groups, names)) for every row whose cell names groups.
    # On merge a cell adds to what an existing person is already in and never
    # removes a membership, so a blank cell leaves them alone; rebuild deleted
    # every group first, so there the cell is the whole membership.
    assignments = []
    for sort_order, row in enumerate(rows, 1):
        organizer_managed = addresses.manages(row.email)
        if organizer_managed:
            contact_email = addresses.contact_for(row.email)
            member = None
            participant = managed.get(managed_key(contact_email, row.name))
        else:
            contact_email = ""
            member = members[row.email]
            participant = existing.get(member.pk)
        all_groups, group_names = parse_group_cell(row.group_name)
        if participant is None:
            if organizer_managed:
                member = _managed_member(row.name)
                new_members.append(member)
            else:
                invitation_emails.append(row.email)
            participant = Participant(
                event=event,
                member=member,
                participant_name=row.name,
                contact_email=contact_email,
                contact_phone=row.phone,
                organizer_managed=organizer_managed,
                availability_inperson=default_availability(event),
                availability_virtual=default_availability(event),
                all_groups=all_groups,
                sort_order=sort_order,
            )
            new_participants.append(participant)
            if group_names:
                assignments.append((participant, (all_groups, group_names)))
        else:
            restored = participant.hidden
            changed = False
            values = {"participant_name": row.name, "hidden": False}
            # A sheet without a phone column, or an empty cell, keeps the phone
            # the organizer already has on file.
            if row.phone:
                values["contact_phone"] = row.phone
            for field, value in values.items():
                if getattr(participant, field) != value:
                    setattr(participant, field, value)
                    changed = True
            if changed:
                participant.version += 1
                changed_participants.append(participant)
            if restored and not organizer_managed:
                invitation_emails.append(row.email)
            if all_groups or group_names:
                assignments.append((participant, (all_groups, group_names)))
        row_participants.append(participant)

    if new_members:
        get_user_model().objects.bulk_create(new_members)
    if new_participants:
        Participant.objects.bulk_create(new_participants)
    if assignments:
        # Membership edits on people already on the roster bump their version
        # like any other identity change; new rows carry their version already.
        bumped = {participant.pk for participant in changed_participants}
        existing_by_pk = {
            participant.pk: participant for participant in [*existing.values(), *managed.values()]
        }
        for participant_id in add_memberships(event=event, assignments=assignments):
            participant = existing_by_pk.get(participant_id)
            if participant is not None and participant.pk not in bumped:
                participant.version += 1
                changed_participants.append(participant)
    if changed_participants:
        Participant.objects.bulk_update(
            changed_participants,
            ["participant_name", "contact_phone", "hidden", "version", "updated_at"],
        )

    UserEvent.objects.bulk_create(
        [
            UserEvent(member_id=participant.member_id, event=event, role="participant")
            for participant in row_participants
        ],
        ignore_conflicts=True,
    )

    invitations = {
        invitation.email: invitation
        for invitation in EventInvitation.objects.select_for_update().filter(
            event=event,
            email__in=[row.email for row in account_rows],
        )
    }
    new_invitations = []
    changed_invitations = []
    for row in account_rows:
        member = members[row.email]
        invitation = invitations.get(row.email)
        if invitation is None:
            new_invitations.append(
                EventInvitation(
                    event=event,
                    email=row.email,
                    member=member,
                    invited_by=organizer,
                )
            )
            continue
        changed = False
        if invitation.member_id != member.pk:
            invitation.member = member
            changed = True
        if invitation.invited_by_id is None:
            invitation.invited_by = organizer
            changed = True
        if changed:
            changed_invitations.append(invitation)
    if new_invitations:
        EventInvitation.objects.bulk_create(new_invitations)
    if changed_invitations:
        EventInvitation.objects.bulk_update(
            changed_invitations,
            ["member", "invited_by", "updated_at"],
        )

    participant_ids = [participant.pk for participant in row_participants]
    weights = {
        weight.participant_id: weight
        for weight in Weight.objects.select_for_update().filter(
            event=event,
            participant_id__in=participant_ids,
        )
    }
    new_weights = []
    changed_weights = []
    for row, participant in zip(rows, row_participants, strict=True):
        weight = weights.get(participant.pk)
        if weight is None:
            new_weights.append(
                Weight(
                    event=event,
                    participant=participant,
                    weight=row.weight,
                    included=row.included,
                )
            )
        elif float(weight.weight) != float(row.weight) or weight.included != row.included:
            weight.weight = row.weight
            weight.included = row.included
            changed_weights.append(weight)
    if new_weights:
        Weight.objects.bulk_create(new_weights)
    if changed_weights:
        Weight.objects.bulk_update(changed_weights, ["weight", "included", "updated_at"])
    return (
        len(new_participants),
        len(rows) - len(new_participants),
        invitation_emails,
    )


def commit_roster_import(*, event: Event, batch_id, organizer, data):
    mode = str(data.get("mode") or "").strip().lower()
    if mode not in RosterImportReceipt.Mode.values:
        raise RosterImportError("mode must be 'merge' or 'rebuild'.")
    try:
        idempotency_key = uuid.UUID(str(data.get("idempotencyKey") or ""))
    except (TypeError, ValueError, AttributeError) as exc:
        raise RosterImportError("idempotencyKey must be a UUID.") from exc
    send_invitations = data.get("sendInvitations", True)
    if not isinstance(send_invitations, bool):
        raise RosterImportError("sendInvitations must be a boolean.")
    fingerprint = _fingerprint(
        {"batchId": str(batch_id), "mode": mode, "sendInvitations": send_invitations}
    )

    try:
        with transaction.atomic():
            event = Event.objects.select_for_update().get(pk=event.pk)
            batch = (
                RosterImportBatch.objects.select_for_update()
                .filter(pk=batch_id, event=event)
                .first()
            )
            if batch is None:
                raise RosterImportError("Participant import not found.", status_code=404)
            previous = RosterImportReceipt.objects.filter(
                event=event,
                idempotency_key=idempotency_key,
            ).first()
            if previous is not None:
                if previous.request_fingerprint != fingerprint:
                    raise RosterImportError(
                        "This idempotency key was already used for a different import.",
                        status_code=409,
                    )
                delivery_request = (
                    EmailDeliveryRequest.objects.prefetch_related("jobs")
                    .filter(
                        event=event,
                        operation=EmailDeliveryRequest.Operation.INVITATION,
                        idempotency_key=idempotency_key,
                    )
                    .first()
                )
                return (
                    previous,
                    True,
                    delivery_request,
                    delivery_request.recipient_count if delivery_request else 0,
                )

            require_preview(batch)
            if event.organizer_id != organizer.pk:
                raise RosterImportError(
                    "Only the organizer can commit a participant import.",
                    status_code=403,
                )
            write_error = response_write_error(event)
            if write_error:
                raise RosterImportError(
                    write_error,
                    status_code=409,
                )
            if getattr(event, "final_meeting", None) is not None and event.final_meeting.active:
                raise RosterImportError(
                    "Reopen this event before changing the participants of a confirmed meeting.",
                    status_code=409,
                )
            if mode == RosterImportReceipt.Mode.REBUILD:
                confirmation_code = str(data.get("confirmationCode") or "").strip().upper()
                if confirmation_code != event.code.upper():
                    raise RosterImportError(
                        "confirmationCode must match the event code for rebuild."
                    )

            rows = list(
                batch.rows.select_for_update()
                .filter(
                    worksheet=batch.selected_worksheet,
                    row_number__gt=batch.header_row,
                    selected=True,
                )
                .order_by("row_number")
            )
            if not rows:
                raise RosterImportError("Select at least one valid row.")
            invalid = [row for row in rows if row.validation_errors]
            if invalid:
                raise RosterImportError(
                    "Resolve or deselect invalid rows before committing.",
                    status_code=409,
                    extra={"invalidRowCount": len(invalid)},
                )
            if len(rows) > MAX_ROSTER_ROWS:
                raise RosterImportError(
                    f"An import may contain at most {MAX_ROSTER_ROWS} participants."
                )
            # The preview classified blank and own-address rows against the
            # organizer's addresses as they were then; refuse rather than bind
            # a row the preview never showed as it would now be imported.
            addresses = organizer_addresses(organizer.pk)
            if any(
                addresses.contact_for(row.email) not in addresses.verified
                for row in rows
                if not row.email or addresses.manages(row.email)
            ):
                raise RosterImportError(
                    "Your email addresses changed after this preview was made. "
                    "Review the rows again before importing.",
                    status_code=409,
                )

            batch.status = RosterImportBatch.Status.COMMITTING
            batch.save(update_fields=["status", "updated_at"])
            now = timezone.now()
            members = _resolve_members([row for row in rows if not addresses.manages(row.email)])
            if mode == RosterImportReceipt.Mode.REBUILD:
                _rebuild_event_roster(event, now)
            created_count, updated_count, invitation_emails = _write_roster(
                event,
                organizer,
                rows,
                members=members,
                addresses=addresses,
            )
            event.results_revision += 1
            event_update_fields = ["results_revision", "updated_at"]
            if mode == RosterImportReceipt.Mode.REBUILD:
                event_update_fields.append("version")
            event.save(update_fields=event_update_fields)
            EventResultSnapshot.objects.update_or_create(
                event=event,
                defaults={
                    "requested_revision": event.results_revision,
                    "status": EventResultSnapshot.Status.REFRESHING,
                    "last_error": "",
                },
            )
            delivery_request = None
            if not send_invitations:
                invitation_emails = []
            if invitation_emails:
                delivery_result = upsert_and_send_invitations(
                    event=event,
                    emails=invitation_emails,
                    invited_by=organizer,
                    idempotency_key=idempotency_key,
                    hydrate_result=False,
                )
                delivery_request = delivery_result["request"]
            receipt = RosterImportReceipt.objects.create(
                event=event,
                batch=batch,
                committed_by=organizer,
                idempotency_key=idempotency_key,
                request_fingerprint=fingerprint,
                mode=mode,
                imported_count=len(rows),
                created_count=created_count,
                updated_count=updated_count,
                results_revision=event.results_revision,
                committed_at=now,
            )
            scrub_batch(
                batch,
                RosterImportBatch.Status.COMMITTED,
                summary={
                    "imported": len(rows),
                    "created": created_count,
                    "updated": updated_count,
                },
            )
            return receipt, False, delivery_request, len(invitation_emails)
    except EventEmailRequestError as exc:
        raise RosterImportError(str(exc), status_code=exc.status_code) from exc
    except IntegrityError as exc:
        raise RosterImportError(
            "The participant list changed concurrently; refresh the preview and try again.",
            status_code=409,
        ) from exc
