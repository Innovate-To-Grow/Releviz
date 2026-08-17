"""Cookie-authenticated endpoints for a temporary participant's single event."""

import logging

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import Throttled
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.permissions import AllowAny
from rest_framework.views import APIView

from apps.authn.models import ContactEmail
from apps.authn.security import (
    client_ip,
    consume_request_rate_limit,
    enforce_cookie_request_origin,
    security_log_key,
)
from apps.authn.services import start_registration
from apps.mail.services import EmailDeliveryError
from apps.scheduling.models import Event, Participant, ScheduleEditRecord
from apps.scheduling.permissions import can_view_event_results, weight_for_participant
from apps.scheduling.serializers import api_event, api_participant
from apps.scheduling.services.aggregation import participant_is_excluded
from apps.scheduling.services.invitations import (
    mark_invitation_for_member,
    mark_invitation_response_withdrawn,
)
from apps.scheduling.services.lifecycle import response_write_error
from apps.scheduling.services.result_snapshots import (
    request_event_results_recompute,
    serialize_result_snapshot,
)
from apps.scheduling.services.slots import validate_availability
from apps.scheduling.services.temp_access import (
    clear_temporary_session_cookie,
    request_temporary_access_code,
    set_temporary_session_cookie,
    temporary_access_rate_identity,
    temporary_session_from_request,
    temporary_session_member_has_full_access,
    verify_temporary_access_code,
)
from apps.scheduling.views.helpers import record_schedule_edit, temp_private_response

logger = logging.getLogger(__name__)
security_logger = logging.getLogger("releviz.security")


def current_member_access_level(member_id) -> str:
    """Read committed account state without joining it into a row-lock query."""

    Member = get_user_model()
    return Member.objects.values_list("access_level", flat=True).get(pk=member_id)


def log_temporary_session_denied(request, *, event_code: str, operation: str) -> None:
    security_logger.warning(
        "temporary_event_session_denied",
        extra={
            "auth_key": security_log_key(str(event_code or "").strip().upper()),
            "auth_scope": "temp_event_session",
            "ip_address": client_ip(request),
            "operation": operation,
        },
    )


def temp_access_payload(session):
    event = session.participant.event
    can_view_results = can_view_event_results(event, session.member)
    payload = {
        "event": api_event(event),
        "participant": api_participant(session.participant),
        "email": session.member.get_primary_email(),
        "canViewResults": can_view_results,
        "sessionExpiresAt": session.expires_at.isoformat(),
    }
    if can_view_results:
        snapshot = serialize_result_snapshot(event)
        payload["resultSnapshot"] = snapshot
        payload["results"] = snapshot["results"]
    return payload


def inactive_session_response(request, *, event_code: str, operation: str):
    """Deny the request and clear the cookie, distinguishing an upgraded account."""

    log_temporary_session_denied(
        request,
        event_code=event_code,
        operation=operation,
    )
    account_upgraded = temporary_session_member_has_full_access(
        request,
        event_code=event_code,
    )
    response = temp_private_response(
        {
            "error": (
                "This account now has full access. Sign in to continue."
                if account_upgraded
                else "Temporary event access is not active."
            ),
            "errorCode": ("temp_account_upgraded" if account_upgraded else "temp_session_inactive"),
        },
        status=403 if account_upgraded else 401,
    )
    clear_temporary_session_cookie(response)
    return response


class TemporaryAccessRequestCodeView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        event_code = str(request.data.get("code") or "").strip()
        invitation_token = str(request.data.get("invitationToken") or "").strip()
        identity = temporary_access_rate_identity(event_code, invitation_token)
        quota = consume_request_rate_limit(
            "temp_access_code_request",
            request,
            identity,
        )
        if not quota.allowed:
            raise Throttled(wait=quota.retry_after)
        try:
            request_temporary_access_code(
                event_code=event_code,
                access_token=invitation_token,
            )
        except Exception:
            # Do not reveal whether the event, invitation, or temporary account
            # exists. Operational failures remain visible in server logs.
            logger.exception("temporary_access_code_request_failed")
        return temp_private_response(
            {"message": ("If this access link is valid, a verification code has been sent.")},
            status=202,
        )


class TemporaryAccessVerifyView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        # This response sets the event-scoped HttpOnly cookie, so apply the
        # same login-CSRF protection used by every other cookie mutation.
        enforce_cookie_request_origin(request)
        event_code = str(request.data.get("code") or "").strip()
        invitation_token = str(request.data.get("invitationToken") or "").strip()
        verification_code = str(request.data.get("verificationCode") or "").strip()
        identity = temporary_access_rate_identity(event_code, invitation_token)
        quota = consume_request_rate_limit(
            "temp_access_code_verify",
            request,
            identity,
        )
        if not quota.allowed:
            raise Throttled(wait=quota.retry_after)
        try:
            credential = verify_temporary_access_code(
                event_code=event_code,
                access_token=invitation_token,
                code=verification_code,
                request=request,
            )
        except DRFValidationError:
            credential = None
        if credential is None:
            security_logger.warning(
                "temporary_access_code_verification_failed",
                extra={
                    "auth_key": security_log_key(identity),
                    "auth_scope": "temp_access_code_verify",
                    "ip_address": client_ip(request),
                },
            )
            return temp_private_response(
                {"error": "Invalid or expired verification code."},
                status=400,
            )
        response = temp_private_response(temp_access_payload(credential.session))
        set_temporary_session_cookie(response, credential)
        return response


class TemporaryAccessSessionView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        event_code = str(request.query_params.get("code") or "").strip()
        if not event_code:
            return temp_private_response({"error": "code is required"}, status=400)
        session = temporary_session_from_request(request, event_code=event_code)
        if session is None:
            return inactive_session_response(
                request,
                event_code=event_code,
                operation="read_session",
            )
        return temp_private_response(temp_access_payload(session))


class TemporaryAccessUpgradeRegistrationView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        enforce_cookie_request_origin(request)
        event_code = str(request.query_params.get("code") or "").strip()
        if not event_code:
            return temp_private_response({"error": "code is required"}, status=400)

        session = temporary_session_from_request(request, event_code=event_code)
        if session is None:
            return inactive_session_response(
                request,
                event_code=event_code,
                operation="start_upgrade",
            )

        quota = consume_request_rate_limit(
            "register",
            request,
            str(session.member_id),
        )
        if not quota.allowed:
            raise Throttled(wait=quota.retry_after)

        contact = ContactEmail.objects.filter(
            member_id=session.member_id,
            email_type="primary",
            verified=False,
        ).first()
        if contact is None:
            security_logger.warning(
                "temporary_upgrade_registration_identity_unavailable",
                extra={
                    "event_id": str(session.participant.event_id),
                    "member_id": str(session.member_id),
                    "temporary_session_id": str(session.pk),
                },
            )
            return temp_private_response(
                {"detail": "Unable to start registration."},
                status=409,
            )

        registration_data = request.data.copy()
        # The event-scoped session is the identity authority for an upgrade.
        # Never trust an email supplied by the browser for this operation.
        registration_data["email"] = contact.email_address
        try:
            member = start_registration(
                registration_data,
                _temporary_upgrade_member_id=session.member_id,
            )
        except DRFValidationError as exc:
            return temp_private_response(exc.detail, status=400)
        except EmailDeliveryError:
            security_logger.warning(
                "temporary_upgrade_registration_delivery_failed",
                extra={
                    "event_id": str(session.participant.event_id),
                    "member_id": str(session.member_id),
                    "temporary_session_id": str(session.pk),
                },
            )
            return temp_private_response(
                {"detail": "Unable to send the verification code."},
                status=503,
            )

        if member.pk != session.member_id:
            security_logger.error(
                "temporary_upgrade_registration_identity_mismatch",
                extra={
                    "event_id": str(session.participant.event_id),
                    "member_id": str(session.member_id),
                    "temporary_session_id": str(session.pk),
                },
            )
            raise RuntimeError("Temporary upgrade registration identity mismatch.")

        security_logger.info(
            "temporary_upgrade_registration_started",
            extra={
                "event_id": str(session.participant.event_id),
                "member_id": str(session.member_id),
                "temporary_session_id": str(session.pk),
            },
        )
        return temp_private_response(
            {
                "message": "Registration started. Check your email for a verification code.",
                "requiresRegistrationDetailsOnVerify": True,
            },
            status=202,
        )


class TemporaryAccessParticipantView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    @transaction.atomic
    def put(self, request):
        enforce_cookie_request_origin(request)
        event_code = str(request.query_params.get("code") or "").strip()
        if not event_code:
            return temp_private_response({"error": "code is required"}, status=400)
        session = temporary_session_from_request(request, event_code=event_code)
        if session is None:
            return inactive_session_response(
                request,
                event_code=event_code,
                operation="update_participant",
            )

        participant = Participant.objects.select_for_update(of=("self",)).get(
            pk=session.participant_id
        )
        event = Event.objects.get(pk=participant.event_id)
        participant.event = event
        if current_member_access_level(participant.member_id) != "temporary":
            session.revoke()
            response = temp_private_response(
                {
                    "error": "This account now has full access. Sign in to continue.",
                    "errorCode": "temp_account_upgraded",
                },
                status=403,
            )
            clear_temporary_session_cookie(response)
            return response
        if "email" in request.data or "contactEmail" in request.data:
            return temp_private_response(
                {
                    "error": "Participant email cannot be changed.",
                    "errorCode": "participant_email_immutable",
                },
                status=400,
            )
        write_error = response_write_error(event)
        if write_error:
            return temp_private_response(
                {
                    "error": write_error,
                    "errorCode": "event_responses_locked",
                },
                status=409,
            )
        weight = weight_for_participant(event, participant)
        if participant_is_excluded(participant, weight):
            return temp_private_response(
                {
                    "error": "Excluded participants cannot change availability",
                    "errorCode": "participant_excluded",
                },
                status=403,
            )

        updates = {}
        for field, label, target in (
            (
                "availabilityInperson",
                "availabilityInperson",
                "availability_inperson",
            ),
            (
                "availabilityVirtual",
                "availabilityVirtual",
                "availability_virtual",
            ),
        ):
            if field in request.data:
                error = validate_availability(request.data[field], event, label)
                if error:
                    return temp_private_response({"error": error}, status=400)
                updates[target] = request.data[field]
        if "submitted" in request.data:
            submitted = request.data["submitted"]
            if submitted not in {0, 1}:
                return temp_private_response(
                    {"error": "submitted must be a boolean"},
                    status=400,
                )
            updates["submitted"] = bool(submitted)
        if not updates:
            return temp_private_response({"participant": api_participant(participant)})

        expected_version = request.data.get("expectedVersion")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int):
            return temp_private_response(
                {
                    "error": "expectedVersion is required",
                    "errorCode": "participant_version_required",
                },
                status=428,
            )
        values_match = all(getattr(participant, key) == value for key, value in updates.items())
        if participant.version != expected_version and not values_match:
            return temp_private_response(
                {
                    "error": (
                        "Your availability changed in another session. Reload before saving again."
                    ),
                    "errorCode": "participant_version_conflict",
                    "participant": api_participant(participant),
                },
                status=409,
            )
        if values_match:
            return temp_private_response({"participant": api_participant(participant)})

        was_submitted = participant.submitted
        for key, value in updates.items():
            setattr(participant, key, value)
        timestamp_fields = []
        now = timezone.now()
        if participant.submitted:
            if participant.first_submitted_at is None:
                participant.first_submitted_at = now
                timestamp_fields.append("first_submitted_at")
            participant.last_submitted_at = now
            timestamp_fields.append("last_submitted_at")
        elif participant.first_draft_saved_at is None:
            participant.first_draft_saved_at = now
            timestamp_fields.append("first_draft_saved_at")
        participant.version += 1
        participant.save(
            update_fields=[*updates.keys(), *timestamp_fields, "version", "updated_at"]
        )
        if participant.submitted:
            mark_invitation_for_member(
                event=event,
                member=participant.member,
                submitted=True,
            )
        elif was_submitted:
            mark_invitation_response_withdrawn(event=event, member=participant.member)
        else:
            mark_invitation_for_member(
                event=event,
                member=participant.member,
                draft_saved=True,
            )
        record_schedule_edit(
            event=event,
            participant=participant,
            actor=session.member,
            source=ScheduleEditRecord.Source.SELF,
            was_submitted=was_submitted,
        )
        request_event_results_recompute(event)
        security_logger.info(
            "temporary_participant_response_updated",
            extra={
                "event_id": str(event.pk),
                "member_id": str(participant.member_id),
                "participant_version": participant.version,
                "submitted": participant.submitted,
            },
        )
        return temp_private_response({"participant": api_participant(participant)})


class TemporaryAccessLogoutView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        enforce_cookie_request_origin(request)
        session = temporary_session_from_request(
            request,
            update_last_seen=False,
        )
        if session is not None:
            session.revoke()
            security_logger.info(
                "temporary_event_session_revoked",
                extra={
                    "temporary_session_id": str(session.pk),
                    "member_id": str(session.member_id),
                },
            )
        response = temp_private_response(status=204)
        clear_temporary_session_cookie(response)
        return response
