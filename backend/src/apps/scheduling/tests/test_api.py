from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.models import Event, Participant, UserEvent, Weight
from apps.scheduling.utils import (
    api_event,
    default_schedule,
    expected_schedule_length,
    schedule_to_storage,
    validate_schedule,
)


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

    def test_health_and_missing_or_unknown_event_errors(self):
        self.assertEqual(self.client.get("/api/health").data, {"ok": True})
        self.authenticate(self.organizer)
        for path in [
            "/api/events",
            "/api/events/participants",
            "/api/events/participants/update",
            "/api/events/participants/update/unhide",
            "/api/events/weights",
        ]:
            response = self.client.get(path) if "update" not in path else self.client.put(path)
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/events?code=NOPE").status_code, 404)
        self.assertEqual(self.client.get("/api/events/participants?code=NOPE").status_code, 404)
        self.assertEqual(
            self.client.put(
                "/api/events/participants/update?code=NOPE&participantId=x"
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.put(
                "/api/events/participants/update/unhide?code=NOPE&participantId=x"
            ).status_code,
            404,
        )
        self.assertEqual(self.client.get("/api/events/weights?code=NOPE").status_code, 404)

    def test_event_create_validation_and_defaults(self):
        self.authenticate(self.organizer)
        invalid_payloads = [
            ({}, "Name is required"),
            ({"name": "x" * 201}, "Event name too long"),
            ({"name": "Planning", "startHour": "9"}, "Hours must be integers"),
            ({"name": "Planning", "startHour": 12, "endHour": 12}, "Invalid time range"),
            ({"name": "Planning", "days": [7]}, "Days must be integers"),
            ({"name": "Planning", "mode": "phone"}, "Invalid mode"),
            ({"name": "Planning", "location": "x" * 501}, "Location too long"),
            ({"name": "Planning", "daySelectionType": "calendar"}, "Invalid daySelectionType"),
            (
                {"name": "Planning", "daySelectionType": "specific_dates"},
                "specificDates must be a non-empty array",
            ),
            (
                {
                    "name": "Planning",
                    "daySelectionType": "specific_dates",
                    "specificDates": ["07/08/2026"],
                },
                "specificDates must be ISO date strings",
            ),
            (
                {"name": "Planning", "participantViewPermission": "everybody"},
                "Invalid participantViewPermission",
            ),
        ]
        for payload, message in invalid_payloads:
            with self.subTest(message=message):
                response = self.client.post("/api/events", payload, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertIn(message, response.data["error"])

        response = self.client.post(
            "/api/events",
            {"name": "Virtual", "mode": "virtual"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["event"]["location"], "")

        response = self.client.post(
            "/api/events",
            {
                "name": "Dates",
                "startHour": 9,
                "endHour": 10,
                "daySelectionType": "specific_dates",
                "specificDates": ["2026-07-08", "2026-07-09"],
                "participantViewPermission": "all",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        event = Event.objects.get(code=response.data["event"]["code"])
        self.assertEqual(expected_schedule_length(event), 2)
        data = api_event(event)
        self.assertEqual(data["specificDates"], ["2026-07-08", "2026-07-09"])

    def test_event_code_generation_failure(self):
        self.authenticate(self.organizer)
        with patch("apps.scheduling.views.generate_event_code", return_value="DUPLICAT"):
            Event.objects.create(
                code="DUPLICAT",
                name="Existing",
                organizer=self.organizer,
                days=[1],
                start_hour=9,
                end_hour=10,
            )
            response = self.client.post("/api/events", {"name": "New"}, format="json")
        self.assertEqual(response.status_code, 500)

    def test_participant_join_edge_cases_and_include_hidden(self):
        code = self.create_event()
        event = Event.objects.get(code=code)
        nameless = get_user_model().objects.create_user(password="password123", is_active=True)
        self.authenticate(nameless)
        with patch.object(nameless.__class__, "display_name", return_value=""):
            response = self.client.post(f"/api/events/participants?code={code}", {}, format="json")
            self.assertEqual(response.status_code, 400)
        with patch.object(nameless.__class__, "display_name", return_value="x" * 101):
            response = self.client.post(f"/api/events/participants?code={code}", {}, format="json")
            self.assertEqual(response.status_code, 400)

        self.authenticate(self.participant)
        response = self.client.post("/api/events/participants", {}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/events/participants?code=NOPE", {}, format="json")
        self.assertEqual(response.status_code, 404)

        self.client.post(f"/api/events/participants?code={code}", {}, format="json")
        participant = Participant.objects.get(member=self.participant, event=event)
        participant.participant_name = "Changed"
        participant.save(update_fields=["participant_name"])
        repeat = self.client.post(f"/api/events/participants?code={code}", {}, format="json")
        self.assertEqual(repeat.status_code, 200)
        participant.refresh_from_db()
        self.assertEqual(participant.participant_name, "Part Person")

        self.authenticate(self.organizer)
        self.client.delete(
            f"/api/events/participants/update?code={code}&participantId={self.participant.pk}"
        )
        hidden = self.client.get(f"/api/events/participants?code={code}")
        self.assertEqual(hidden.data["participants"], [])
        included = self.client.get(f"/api/events/participants?code={code}&includeHidden=true")
        self.assertEqual(len(included.data["participants"]), 1)
        organizer_join = self.client.post(
            f"/api/events/participants?code={code}", {}, format="json"
        )
        self.assertEqual(organizer_join.status_code, 201)

    def test_participant_update_validation_and_noop(self):
        code = self.create_event()
        self.authenticate(self.participant)
        self.client.post(f"/api/events/participants?code={code}", {}, format="json")
        base = f"/api/events/participants/update?code={code}&participantId={self.participant.pk}"

        response = self.client.put(base, {"scheduleInperson": "[bad"}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.put(base, {"scheduleInperson": "not-list"}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.put(base, {"scheduleInperson": [1]}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.put(base, {"scheduleInperson": [2] * 14}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.put(base, {}, format="json")
        self.assertEqual(response.status_code, 200)
        other = create_member("missing-participant@example.com")
        response = self.client.put(
            f"/api/events/participants/update?code={code}&participantId={other.pk}",
            {"submitted": 1},
            format="json",
        )
        self.assertEqual(response.status_code, 404)

        self.authenticate(self.organizer)
        response = self.client.put(base, {"groupName": "A", "sortOrder": 3}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["participant"]["group_name"], "A")
        response = self.client.put(base, {"groupName": "", "sortOrder": None}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data["participant"]["group_name"])

        other = create_member("other@example.com")
        self.authenticate(self.participant)
        response = self.client.put(base, {"sortOrder": 1}, format="json")
        self.assertEqual(response.status_code, 403)
        self.authenticate(other)
        response = self.client.put(base, {"submitted": 1}, format="json")
        self.assertEqual(response.status_code, 403)
        response = self.client.delete(base)
        self.assertEqual(response.status_code, 403)
        response = self.client.delete(
            f"/api/events/participants/update?code={code}&participantId={other.pk}"
        )
        self.assertEqual(response.status_code, 404)

    def test_unhide_and_weight_validation_errors(self):
        code = self.create_event()
        self.authenticate(self.participant)
        self.client.post(f"/api/events/participants?code={code}", {}, format="json")

        self.authenticate(self.participant)
        response = self.client.put(
            f"/api/events/participants/update/unhide?code={code}&participantId={self.participant.pk}"
        )
        self.assertEqual(response.status_code, 403)

        self.authenticate(self.organizer)
        other = create_member("other-unhide@example.com")
        missing = self.client.put(
            f"/api/events/participants/update/unhide?code={code}&participantId={other.pk}"
        )
        self.assertEqual(missing.status_code, 404)

        self.authenticate(self.participant)
        self.assertEqual(self.client.get(f"/api/events/weights?code={code}").status_code, 403)

        self.authenticate(self.organizer)
        self.assertEqual(
            self.client.put("/api/events/weights", {"weights": []}, format="json").status_code,
            400,
        )
        self.assertEqual(
            self.client.put(
                "/api/events/weights?code=NOPE", {"weights": []}, format="json"
            ).status_code,
            404,
        )
        for payload in [
            {"weights": "bad"},
            {"weights": [{"weight": 0.5, "included": 1}]},
            {"weights": [{"participantId": str(self.participant.pk), "weight": "bad"}]},
            {"weights": [{"participantId": str(self.participant.pk), "weight": -0.1}]},
            {"weights": [{"participantId": str(self.participant.pk), "included": 2}]},
            {"weights": [{"participantId": "missing", "weight": 0.5, "included": 1}]},
        ]:
            with self.subTest(payload=payload):
                response = self.client.put(
                    f"/api/events/weights?code={code}", payload, format="json"
                )
                self.assertEqual(response.status_code, 400)

        response = self.client.put(
            f"/api/events/weights?code={code}",
            {"weights": [{"id": str(self.participant.pk), "weight": 0.75, "included": 0}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.get(f"/api/events/weights?code={code}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["weights"][0]["included"], 0)

        dashboard = self.client.get("/api/dashboard/events")
        self.assertEqual([event["code"] for event in dashboard.data["organized"]], [code])

    def test_model_strings_and_schedule_helpers(self):
        code = self.create_event()
        event = Event.objects.get(code=code)
        self.authenticate(self.participant)
        participant_response = self.client.post(
            f"/api/events/participants?code={code}", {}, format="json"
        )
        participant = Participant.objects.get(member=self.participant, event=event)
        UserEvent.objects.get_or_create(member=self.participant, event=event, role="participant")

        self.assertIn(code, str(event))
        self.assertIn(code, str(participant))
        self.assertIn(code, str(UserEvent.objects.get(member=self.participant, event=event)))
        weight = Weight.objects.create(event=event, participant=participant, weight=0.25)
        self.assertIn("0.25", str(weight))
        self.assertEqual(default_schedule(event), "[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]")
        self.assertEqual(schedule_to_storage([0, 1]), "[0, 1]")
        self.assertEqual(schedule_to_storage("[0, 1]"), "[0, 1]")
        self.assertEqual(validate_schedule({"bad": 1}, event, "x"), "Invalid x: must be an array")
        self.assertIsNone(
            validate_schedule(
                participant_response.data["participant"]["schedule_inperson"],
                event,
                "x",
            )
        )
