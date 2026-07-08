from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.models import ContactEmail


def create_member(email: str, first_name: str = "Test", last_name: str = "User"):
    Member = get_user_model()
    member = Member.objects.create_user(
        password="password123",
        first_name=first_name,
        last_name=last_name,
        email=email,
        is_active=True,
    )
    ContactEmail.objects.create(
        member=member,
        email_address=email,
        email_type="primary",
        verified=True,
    )
    return member


def token_for(member) -> str:
    return str(RefreshToken.for_user(member).access_token)


class SchedulerApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("organizer@example.com", "Org", "Owner")
        self.participant = create_member("participant@example.com", "Part", "Person")

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def create_event(self):
        self.authenticate(self.organizer)
        res = self.client.post(
            "/api/events",
            {
                "name": "Planning",
                "startHour": 9,
                "endHour": 11,
                "days": [1, 2],
                "mode": "mixed",
                "location": "Room 1",
            },
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        return res.data["event"]["code"]

    def test_missing_auth_returns_401(self):
        res = self.client.get("/api/dashboard/events")
        self.assertEqual(res.status_code, 401)

    def test_create_event_uses_authenticated_user_as_organizer(self):
        code = self.create_event()
        res = self.client.get(f"/api/events?code={code}")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["event"]["organizerUserId"], str(self.organizer.pk))

    def test_participant_can_join_submit_and_see_dashboard(self):
        code = self.create_event()

        self.authenticate(self.participant)
        res = self.client.post(f"/api/events/participants?code={code}", {}, format="json")
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data["participant"]["id"], str(self.participant.pk))

        schedule = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]
        res = self.client.put(
            f"/api/events/participants/update?code={code}&participantId={self.participant.pk}",
            {"scheduleInperson": schedule, "submitted": 1},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["participant"]["submitted"], 1)

        res = self.client.get("/api/dashboard/events")
        self.assertEqual(res.status_code, 200)
        self.assertEqual([event["code"] for event in res.data["participating"]], [code])

    def test_non_organizer_cannot_modify_organizer_controls(self):
        code = self.create_event()
        self.authenticate(self.participant)
        self.client.post(f"/api/events/participants?code={code}", {}, format="json")

        res = self.client.put(
            f"/api/events/participants/update?code={code}&participantId={self.participant.pk}",
            {"groupName": "A"},
            format="json",
        )
        self.assertEqual(res.status_code, 403)

        res = self.client.put(
            f"/api/events/weights?code={code}",
            {
                "weights": [
                    {"participantId": str(self.participant.pk), "weight": 0.5, "included": 1}
                ]
            },
            format="json",
        )
        self.assertEqual(res.status_code, 403)

        res = self.client.delete(
            f"/api/events/participants/update?code={code}&participantId={self.participant.pk}"
        )
        self.assertEqual(res.status_code, 403)

    def test_organizer_can_update_weights_hide_and_unhide(self):
        code = self.create_event()
        self.authenticate(self.participant)
        self.client.post(f"/api/events/participants?code={code}", {}, format="json")

        self.authenticate(self.organizer)
        res = self.client.put(
            f"/api/events/weights?code={code}",
            {
                "weights": [
                    {"participantId": str(self.participant.pk), "weight": 0.5, "included": 1}
                ]
            },
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["weights"][0]["weight"], 0.5)

        res = self.client.delete(
            f"/api/events/participants/update?code={code}&participantId={self.participant.pk}"
        )
        self.assertEqual(res.status_code, 200)

        res = self.client.put(
            f"/api/events/participants/update/unhide?code={code}&participantId={self.participant.pk}"
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["participant"]["hidden"], 0)
