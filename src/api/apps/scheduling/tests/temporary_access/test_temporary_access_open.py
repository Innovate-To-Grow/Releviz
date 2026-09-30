"""The private invitation link is the credential: opening it starts the session."""

import hashlib
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.core import mail
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.models import EmailAuthChallenge, Member
from apps.authn.security import RateLimitDecision
from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.models import (
    Event,
    EventInvitation,
    Participant,
    TemporaryEventSession,
)
from apps.scheduling.services.temporary_access import temporary_access_rate_identity

OPEN_URL = "/events/temp-access/open"
COOKIE = settings.TEMP_EVENT_COOKIE_NAME
INACTIVE_BODY = {
    "error": "This invitation link is not active.",
    "errorCode": "temp_invitation_inactive",
}


class TemporaryAccessOpenTests(TestCase):
    def setUp(self):
        self.organizer = create_member("open-owner@example.com", "Open", "Owner")
        self.organizer_client = APIClient()
        self.organizer_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")
        self.event = self.create_event("TOPEN123")
        self.invitation = self.invite(self.event, "invitee@example.com")

    def create_event(self, code):
        return Event.objects.create(
            code=code,
            name=f"Event {code}",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            access_mode="open_link",
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )

    def invite(self, event, email, *, member=None, sent=True, participant=True):
        if member is None:
            member = create_member(
                email,
                "Temp",
                "Invitee",
                access_level="temporary",
                contact_verified=False,
            )
            member.set_unusable_password()
            member.save(update_fields=["password"])
        if participant:
            Participant.objects.create(
                event=event,
                member=member,
                participant_name="Temp Invitee",
                availability_inperson=[0, 0],
                availability_virtual=[0, 0],
            )
        return EventInvitation.objects.create(
            event=event,
            member=member,
            email=email,
            invited_by=self.organizer,
            first_sent_at=timezone.now() if sent else None,
            last_sent_at=timezone.now() if sent else None,
        )

    def payload(self, invitation=None, **overrides):
        invitation = invitation or self.invitation
        return {
            "code": invitation.event.code,
            "invitationToken": str(invitation.access_token),
            **overrides,
        }

    def open(self, client=None, invitation=None, **extra):
        return (client or APIClient()).post(
            OPEN_URL, self.payload(invitation), format="json", **extra
        )

    def raw_cookie(self, client):
        return client.cookies[COOKIE].value

    def mint_session(self, invitation, secret="minted-secret", **fields):
        participant = Participant.objects.get(event=invitation.event, member=invitation.member)
        session = TemporaryEventSession.objects.create(
            member=invitation.member,
            participant=participant,
            invitation=invitation,
            secret_hash=hashlib.sha256(secret.encode()).hexdigest(),
            expires_at=fields.pop("expires_at", timezone.now() + timedelta(days=7)),
            **fields,
        )
        return session, f"{session.pk}.{secret}"

    def client_with_cookie(self, value):
        client = APIClient()
        client.cookies[COOKIE] = value
        return client

    @override_settings(TEMP_EVENT_COOKIE_SECURE=True)
    def test_opening_the_link_returns_the_schedule_and_sets_the_event_scoped_cookie(self):
        client = APIClient()
        opened = client.post(
            OPEN_URL,
            self.payload(),
            format="json",
            HTTP_USER_AGENT="Open Test Browser",
            REMOTE_ADDR="203.0.113.7",
        )

        self.assertEqual(opened.status_code, 200, opened.data)
        self.assertEqual(opened.data["event"]["code"], self.event.code)
        self.assertEqual(opened.data["participant"]["id"], str(self.invitation.member_id))
        self.assertEqual(opened.data["email"], "invitee@example.com")
        self.assertIs(opened.data["canViewResults"], False)
        session = TemporaryEventSession.objects.get()
        self.assertEqual(opened.data["sessionExpiresAt"], session.expires_at.isoformat())
        self.assertEqual(session.invitation, self.invitation)
        self.assertEqual(session.member_id, self.invitation.member_id)
        self.assertEqual(session.participant.event, self.event)
        self.assertEqual(session.ip_address, "203.0.113.7")
        self.assertEqual(session.user_agent, "Open Test Browser")
        self.assertGreater(session.expires_at, timezone.now() + timedelta(days=6))

        cookie = opened.cookies[COOKIE]
        self.assertTrue(cookie["httponly"])
        self.assertTrue(cookie["secure"])
        self.assertEqual(cookie["samesite"], "Lax")
        self.assertEqual(cookie["path"], "/events/temp-access/")
        session_id, raw_secret = cookie.value.split(".", 1)
        self.assertEqual(session_id, str(session.pk))
        self.assertEqual(session.secret_hash, hashlib.sha256(raw_secret.encode()).hexdigest())
        self.assertNotEqual(session.secret_hash, raw_secret)
        self.assertIn("no-store", opened["Cache-Control"])
        self.assertIn("private", opened["Cache-Control"])

        # The cookie alone now reads and edits the schedule.
        current = client.get(f"/events/temp-access/session?code={self.event.code}")
        self.assertEqual(current.status_code, 200)
        self.assertEqual(current.data["participant"]["id"], opened.data["participant"]["id"])

    def test_opening_never_sends_email_or_issues_a_challenge(self):
        self.assertEqual(self.open().status_code, 200)

        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(EmailAuthChallenge.objects.exists())

    def test_opening_records_the_open_without_accepting_or_joining(self):
        roster_url = f"/events/roster?code={self.event.code}"
        before = self.organizer_client.get(roster_url).data["participants"][0]
        self.assertEqual(before["invitationStatus"], "sent")
        self.assertTrue(before["canOrganizerEditEmail"])

        client = APIClient()
        self.assertEqual(self.open(client).status_code, 200)

        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.status, EventInvitation.Status.OPENED)
        self.assertIsNotNone(self.invitation.opened_at)
        self.assertIsNone(self.invitation.accepted_at)
        self.assertIsNone(self.invitation.joined_at)
        self.assertIsNone(self.invitation.draft_saved_at)
        self.assertIsNone(self.invitation.submitted_at)
        after = self.organizer_client.get(roster_url).data["participants"][0]
        self.assertEqual(after["invitationStatus"], "sent")
        # Opening the link is signing in with it: the address is locked from here on.
        self.assertFalse(after["canOrganizerEditEmail"])

        participant = Participant.objects.get(event=self.event, member=self.invitation.member)
        saved = client.put(
            f"/events/temp-access/participant?code={self.event.code}",
            {
                "availabilityInperson": [1, 0],
                "submitted": 0,
                "expectedVersion": participant.version,
            },
            format="json",
            HTTP_ORIGIN="http://testserver",
        )
        self.assertEqual(saved.status_code, 200, saved.data)

        # The invitee's own save is what accepts and joins.
        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.status, EventInvitation.Status.DRAFT_SAVED)
        self.assertIsNotNone(self.invitation.accepted_at)
        self.assertIsNotNone(self.invitation.joined_at)
        accepted = self.organizer_client.get(roster_url).data["participants"][0]
        self.assertEqual(accepted["invitationStatus"], "accepted")

    def test_reopening_with_the_same_cookie_reuses_the_session(self):
        client = APIClient()
        first = self.open(client)
        session = TemporaryEventSession.objects.get()
        self.invitation.refresh_from_db()
        opened_at = self.invitation.opened_at
        stale_seen = timezone.now() - timedelta(hours=1)
        TemporaryEventSession.objects.filter(pk=session.pk).update(last_seen_at=stale_seen)

        second = self.open(client)

        self.assertEqual(second.status_code, 200, second.data)
        self.assertEqual(second.data, first.data)
        self.assertNotIn(COOKIE, second.cookies)
        self.assertEqual(TemporaryEventSession.objects.count(), 1)
        session.refresh_from_db()
        self.assertGreater(session.last_seen_at, stale_seen)
        self.assertIsNone(session.revoked_at)
        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.opened_at, opened_at)
        self.assertIn("no-store", second["Cache-Control"])

    def test_a_second_browser_gets_its_own_session(self):
        first_browser = APIClient()
        second_browser = APIClient()
        self.assertEqual(self.open(first_browser).status_code, 200)
        self.assertEqual(self.open(second_browser).status_code, 200)

        self.assertEqual(TemporaryEventSession.objects.count(), 2)
        self.assertNotEqual(self.raw_cookie(first_browser), self.raw_cookie(second_browser))
        for browser in (first_browser, second_browser):
            current = browser.get(f"/events/temp-access/session?code={self.event.code}")
            self.assertEqual(current.status_code, 200)

    def test_another_invitation_of_the_event_replaces_the_cookie(self):
        other = self.invite(self.event, "second@example.com")
        client = APIClient()
        self.open(client)
        first_cookie = self.raw_cookie(client)

        switched = self.open(client, other)

        self.assertEqual(switched.status_code, 200, switched.data)
        self.assertEqual(switched.data["email"], "second@example.com")
        self.assertEqual(switched.data["participant"]["id"], str(other.member_id))
        self.assertIn(COOKIE, switched.cookies)
        self.assertNotEqual(switched.cookies[COOKIE].value, first_cookie)
        self.assertEqual(TemporaryEventSession.objects.count(), 2)
        self.assertEqual(
            TemporaryEventSession.objects.get(
                pk=switched.cookies[COOKIE].value.split(".")[0]
            ).invitation,
            other,
        )
        current = client.get(f"/events/temp-access/session?code={self.event.code}")
        self.assertEqual(current.data["email"], "second@example.com")

    def test_a_cookie_for_another_event_is_not_reused(self):
        other_event = self.create_event("TOPEN456")
        other = self.invite(other_event, "invitee@example.com", member=self.invitation.member)
        client = APIClient()
        self.open(client)
        first_cookie = self.raw_cookie(client)

        opened = self.open(client, other)

        self.assertEqual(opened.status_code, 200, opened.data)
        self.assertEqual(opened.data["event"]["code"], "TOPEN456")
        self.assertIn(COOKIE, opened.cookies)
        self.assertNotEqual(opened.cookies[COOKIE].value, first_cookie)
        self.assertEqual(TemporaryEventSession.objects.count(), 2)
        self.assertEqual(TemporaryEventSession.objects.filter(invitation=other).count(), 1)

    def test_a_cookie_that_is_no_longer_a_live_session_is_replaced(self):
        other = self.invite(self.event, "other@example.com")
        revoked, revoked_cookie = self.mint_session(self.invitation, "revoked-secret")
        revoked.revoke()
        _expired, expired_cookie = self.mint_session(
            self.invitation,
            "expired-secret",
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        live, _live_cookie = self.mint_session(self.invitation, "live-secret")
        wrong_secret_cookie = f"{live.pk}.not-the-secret"
        # Somebody else's live session is not this invitation's session.
        _foreign, foreign_cookie = self.mint_session(other, "foreign-secret")
        cases = {
            "revoked": revoked_cookie,
            "expired": expired_cookie,
            "wrong secret": wrong_secret_cookie,
            "malformed": "not-a-session",
            "another invitation": foreign_cookie,
        }

        for label, cookie_value in cases.items():
            with self.subTest(label):
                before = TemporaryEventSession.objects.count()
                client = self.client_with_cookie(cookie_value)

                opened = self.open(client)

                self.assertEqual(opened.status_code, 200, opened.data)
                self.assertIn(COOKIE, opened.cookies)
                self.assertNotEqual(opened.cookies[COOKIE].value, cookie_value)
                self.assertEqual(TemporaryEventSession.objects.count(), before + 1)

    def test_every_inactive_link_gets_the_same_404_and_sets_nothing(self):
        upgraded = self.invite(self.event, "upgraded@example.com")
        Member.objects.filter(pk=upgraded.member_id).update(access_level="full")
        deactivated = self.invite(self.event, "deactivated@example.com")
        Member.objects.filter(pk=deactivated.member_id).update(is_active=False)
        unsent = self.invite(self.event, "unsent@example.com", sent=False)
        orphaned = self.invite(self.event, "orphaned@example.com", participant=False)
        memberless = self.invite(self.event, "memberless@example.com")
        EventInvitation.objects.filter(pk=memberless.pk).update(member=None)
        other_event = self.create_event("TOPEN789")
        cases = {
            "unknown event": {**self.payload(), "code": "NOSUCH99"},
            "another event's code": {**self.payload(), "code": other_event.code},
            "missing event": {"invitationToken": str(self.invitation.access_token)},
            "malformed token": {**self.payload(), "invitationToken": "not-a-uuid"},
            "unknown token": {**self.payload(), "invitationToken": str(uuid.uuid4())},
            "missing token": {"code": self.event.code},
            "empty body": {},
            "invitation never sent": self.payload(unsent),
            "member upgraded to full": self.payload(upgraded),
            "inactive member": self.payload(deactivated),
            "participant missing": self.payload(orphaned),
            "invitation without a member": self.payload(memberless),
        }

        for label, body in cases.items():
            with self.subTest(label):
                client = APIClient()
                response = client.post(OPEN_URL, body, format="json")

                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.data, INACTIVE_BODY)
                self.assertNotIn(COOKIE, response.cookies)
                self.assertIn("no-store", response["Cache-Control"])
        self.assertFalse(TemporaryEventSession.objects.exists())
        for invitation in (unsent, upgraded, deactivated, orphaned, memberless, self.invitation):
            invitation.refresh_from_db()
            self.assertIsNone(invitation.opened_at)
            self.assertEqual(invitation.status, EventInvitation.Status.INVITED)

    def test_a_link_that_stopped_working_is_refused_even_with_its_old_cookie(self):
        client = APIClient()
        self.assertEqual(self.open(client).status_code, 200)
        Member.objects.filter(pk=self.invitation.member_id).update(access_level="full")

        refused = self.open(client)

        self.assertEqual(refused.status_code, 404)
        self.assertEqual(refused.data, INACTIVE_BODY)
        self.assertEqual(TemporaryEventSession.objects.count(), 1)

    def test_a_rejected_open_is_logged_without_the_token(self):
        token = str(uuid.uuid4())
        with self.assertLogs("releviz.security", level="WARNING") as logs:
            response = APIClient().post(
                OPEN_URL,
                {"code": self.event.code, "invitationToken": token},
                format="json",
                REMOTE_ADDR="203.0.113.9",
            )

        self.assertEqual(response.status_code, 404)
        record = logs.records[-1]
        self.assertEqual(record.getMessage(), "temporary_access_open_rejected")
        self.assertEqual(record.auth_scope, "temp_access_open")
        self.assertEqual(record.ip_address, "203.0.113.9")
        self.assertNotIn(token, str(record.auth_key))

    def test_a_new_session_is_logged_as_issued(self):
        with self.assertLogs("releviz.security", level="INFO") as logs:
            self.assertEqual(self.open().status_code, 200)

        record = next(
            record
            for record in logs.records
            if record.getMessage() == "temporary_event_session_issued"
        )
        self.assertEqual(record.invitation_id, str(self.invitation.pk))
        self.assertEqual(record.temporary_session_id, str(TemporaryEventSession.objects.get().pk))

    def test_equivalent_spellings_of_one_link_share_one_rate_limit_identity(self):
        token = self.invitation.access_token
        canonical = temporary_access_rate_identity(self.event.code, token)
        for code, spelled in (
            (self.event.code.lower(), token),
            (f" {self.event.code} ", token.hex.upper()),
            (self.event.code, f"{{{token}}}"),
        ):
            with self.subTest(code=code, token=spelled):
                self.assertEqual(temporary_access_rate_identity(code, spelled), canonical)

        with patch(
            "apps.scheduling.views.temporary_access.open.consume_request_rate_limit",
            return_value=RateLimitDecision(allowed=True),
        ) as consume:
            for code, spelled in (
                (f"  {self.event.code.lower()} ", str(token).upper()),
                (self.event.code, token.hex),
            ):
                APIClient().post(
                    OPEN_URL,
                    {"code": code, "invitationToken": spelled},
                    format="json",
                )
        identities = {call.args[2] for call in consume.call_args_list}
        self.assertEqual(identities, {canonical})
        self.assertEqual({call.args[0] for call in consume.call_args_list}, {"temp_access_open"})

    def test_one_link_is_limited_to_twenty_opens_per_window_from_any_spelling(self):
        token = str(self.invitation.access_token)
        spellings = [
            {"code": self.event.code, "invitationToken": token},
            {"code": f" {self.event.code} ", "invitationToken": token.upper()},
            {"code": self.event.code, "invitationToken": token.replace("-", "")},
        ]
        for index in range(20):
            response = APIClient().post(
                OPEN_URL,
                spellings[index % len(spellings)],
                format="json",
                REMOTE_ADDR=f"198.51.100.{index + 1}",
            )
            self.assertEqual(response.status_code, 200, index)

        limited = APIClient().post(
            OPEN_URL, spellings[0], format="json", REMOTE_ADDR="198.51.100.99"
        )

        self.assertEqual(limited.status_code, 429)
        self.assertGreater(int(limited["Retry-After"]), 0)
        self.assertEqual(TemporaryEventSession.objects.count(), 20)

    def test_a_throttled_open_returns_429_with_retry_after_and_opens_nothing(self):
        with patch(
            "apps.scheduling.views.temporary_access.open.consume_request_rate_limit",
            return_value=RateLimitDecision(allowed=False, retry_after=7),
        ):
            throttled = self.open()

        self.assertEqual(throttled.status_code, 429)
        self.assertEqual(throttled["Retry-After"], "7")
        self.assertNotIn(COOKIE, throttled.cookies)
        self.assertFalse(TemporaryEventSession.objects.exists())
        self.invitation.refresh_from_db()
        self.assertIsNone(self.invitation.opened_at)

    def test_a_cross_origin_open_is_refused_before_anything_happens(self):
        client = APIClient()

        refused = self.open(client, HTTP_ORIGIN="https://attacker.example")

        self.assertEqual(refused.status_code, 403)
        self.assertNotIn(COOKIE, refused.cookies)
        self.assertFalse(TemporaryEventSession.objects.exists())
        self.invitation.refresh_from_db()
        self.assertIsNone(self.invitation.opened_at)

        allowed = self.open(client, HTTP_ORIGIN="http://testserver")
        self.assertEqual(allowed.status_code, 200, allowed.data)
        self.assertEqual(TemporaryEventSession.objects.count(), 1)

    def test_the_open_endpoint_only_accepts_post(self):
        self.assertEqual(APIClient().get(OPEN_URL).status_code, 405)

    def test_the_code_endpoints_are_gone(self):
        for path in ("request-code", "verify"):
            with self.subTest(path):
                response = APIClient().post(
                    f"/events/temp-access/{path}",
                    {**self.payload(), "verificationCode": "123456"},
                    format="json",
                )
                self.assertEqual(response.status_code, 404)
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(EmailAuthChallenge.objects.exists())
        self.assertFalse(TemporaryEventSession.objects.exists())
