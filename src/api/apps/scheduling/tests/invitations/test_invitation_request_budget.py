"""Which requests spend the organizer's hourly invitation request budget.

Only a request that can email someone spends it. Adding a person without
inviting them and previewing a send email nobody, so reviewing each
invitation before it goes out costs no more requests than sending it
straight away did.
"""

import uuid

from django.conf import settings
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.mail.models import EmailDeliveryJob
from apps.scheduling.models import Event, Participant, UserEvent


def request_budget(limit):
    """``limit`` invitation requests an hour, per organizer and per address."""

    limits = {
        **settings.AUTH_RATE_LIMITS,
        "invitation_request": {
            "ip": {"limit": limit, "window": 3600, "block": 3600},
            "identity": {"limit": limit, "window": 3600, "block": 3600},
        },
    }
    return override_settings(AUTH_RATE_LIMITS=limits)


class InvitationRequestBudgetTests(TestCase):
    def setUp(self):
        self.organizer = create_member("budget-owner@example.com", "Olive", "Organizer")
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")
        self.event = Event.objects.create(
            code="BUDGET01",
            name="Planning day",
            organizer=self.organizer,
            status=Event.Status.ACTIVE,
            opened_at=timezone.now(),
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        UserEvent.objects.create(member=self.organizer, event=self.event, role="organizer")

    def add(self, index, **flags):
        """The add panel's request; ``flags`` may carry ``sendInvitation``."""

        return self.client.post(
            f"/events/participants/managed?code={self.event.code}",
            {
                "name": f"Person {index}",
                "email": f"person{index}@example.com",
                "idempotencyKey": str(uuid.uuid4()),
                **flags,
            },
            format="json",
        )

    def invitations(self, participant_pk, **payload):
        return self.client.post(
            f"/events/roster/invitations?code={self.event.code}",
            {"participantIds": [str(participant_pk)], **payload},
            format="json",
        )

    def add_for_review(self, index):
        """Add someone without inviting them, as 'Add and send invitation' now does."""

        added = self.add(index, sendInvitation=False)
        self.assertEqual(added.status_code, 201, added.data)
        return Participant.objects.get(event=self.event, participant_name=f"Person {index}").pk

    def test_reviewing_each_invitation_costs_only_the_send(self):
        with request_budget(2):
            for index in range(2):
                participant_pk = self.add_for_review(index)
                # The review, then 'Email them again too' asking again.
                for payload in [{"preview": True}, {"preview": True, "resend": True}]:
                    preview = self.invitations(participant_pk, **payload)
                    self.assertEqual(preview.status_code, 200, preview.data)
                    self.assertEqual(preview.data["willSend"], 1)
                sent = self.invitations(participant_pk, idempotencyKey=str(uuid.uuid4()))
                self.assertEqual(sent.status_code, 202, sent.data)

            # Two sends spent the budget. Adding and reviewing still work;
            # only the next send waits.
            participant_pk = self.add_for_review(2)
            preview = self.invitations(participant_pk, preview=True)
            self.assertEqual(preview.status_code, 200, preview.data)
            self.assertEqual(preview.data["sample"]["email"], "person2@example.com")
            refused = self.invitations(participant_pk, idempotencyKey=str(uuid.uuid4()))
            self.assertEqual(refused.status_code, 429, refused.data)

            # An add that emails, whether asked to or by default, still pays.
            self.assertEqual(self.add(3, sendInvitation=True).status_code, 429)
            self.assertEqual(self.add(4).status_code, 429)
            # So does a preview flag that is not a boolean: it is no preview.
            self.assertEqual(self.invitations(participant_pk, preview="yes").status_code, 429)
            # A body that is not an object asks for nothing free either.
            for url in ["/events/participants/managed", "/events/roster/invitations"]:
                with self.subTest(url=url):
                    listed = self.client.post(
                        f"{url}?code={self.event.code}",
                        [{"sendInvitation": False, "preview": True}],
                        format="json",
                    )
                    self.assertEqual(listed.status_code, 429)

        self.assertEqual(
            sorted(EmailDeliveryJob.objects.values_list("recipient", flat=True)),
            ["person0@example.com", "person1@example.com"],
        )

    def test_a_body_that_is_not_an_object_spends_the_budget_and_is_refused(self):
        with request_budget(1):
            listed = self.client.post(
                f"/events/participants/managed?code={self.event.code}",
                [{"sendInvitation": False}],
                format="json",
            )
            self.assertEqual(listed.status_code, 400, listed.data)
            self.assertEqual(listed.data["error"], "idempotencyKey must be a UUID")
            # That request was charged, so the budget is spent.
            participant_pk = self.add_for_review(0)
            preview = self.client.post(
                f"/events/roster/invitations?code={self.event.code}",
                [{"participantIds": [str(participant_pk)], "preview": True}],
                format="json",
            )
            self.assertEqual(preview.status_code, 429)
