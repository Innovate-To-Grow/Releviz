from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import DatabaseError
from django.test import TestCase
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.models import Event, EventInvitation, Participant, UserEvent, Weight
from apps.scheduling.payloads import api_event
from apps.scheduling.services.availability import (
    default_availability,
    expected_availability_length,
    validate_availability,
)


class RelevizApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("organizer@example.com", "Org", "Owner")
        self.participant = create_member("participant@example.com", "Part", "Person")

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def create_event(self):
        self.authenticate(self.organizer)
        res = self.client.post(
            "/events",
            {
                "name": "Planning",
                "startTime": "09:00",
                "endTime": "11:00",
                "slotMinutes": 30,
                "days": [1, 2],
                "mode": "mixed",
                "location": "Room 1",
                "status": "active",
                "accessMode": "open_link",
            },
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        event = res.data["event"]
        self.assertEqual(event["status"], "active")
        return event["code"]

    def test_missing_auth_returns_401(self):
        res = self.client.get("/dashboard/events")
        self.assertEqual(res.status_code, 401)

    def test_create_event_uses_authenticated_user_as_organizer(self):
        code = self.create_event()
        res = self.client.get(f"/events?code={code}")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["event"]["organizerUserId"], str(self.organizer.pk))

    def test_participant_can_join_submit_and_see_dashboard(self):
        code = self.create_event()

        self.authenticate(self.participant)
        res = self.client.post(f"/events/participants?code={code}", {}, format="json")
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data["participant"]["id"], str(self.participant.pk))

        schedule = [1, 0, 1, 0, 1, 0, 1, 0]
        res = self.client.put(
            f"/events/participants/update?code={code}&participantId={self.participant.pk}",
            {
                "availabilityInperson": schedule,
                "submitted": 1,
                "expectedVersion": res.data["participant"]["version"],
            },
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["participant"]["submitted"], 1)

        res = self.client.get("/dashboard/events")
        self.assertEqual(res.status_code, 200)
        self.assertEqual([event["code"] for event in res.data["participating"]], [code])

    def test_non_organizer_cannot_modify_organizer_controls(self):
        code = self.create_event()
        self.authenticate(self.participant)
        self.client.post(f"/events/participants?code={code}", {}, format="json")

        res = self.client.put(
            f"/events/participants/update?code={code}&participantId={self.participant.pk}",
            {"groupName": "A"},
            format="json",
        )
        self.assertEqual(res.status_code, 403)

        res = self.client.put(
            f"/events/weights?code={code}",
            {
                "weights": [
                    {"participantId": str(self.participant.pk), "weight": 0.5, "included": 1}
                ]
            },
            format="json",
        )
        self.assertEqual(res.status_code, 405)

        res = self.client.delete(
            f"/events/participants/update?code={code}&participantId={self.participant.pk}"
        )
        self.assertEqual(res.status_code, 403)

    def test_organizer_can_update_weights_hide_and_unhide(self):
        code = self.create_event()
        self.authenticate(self.participant)
        self.client.post(f"/events/participants?code={code}", {}, format="json")

        self.authenticate(self.organizer)
        participant = Participant.objects.get(event__code=code, member=self.participant)
        res = self.client.patch(
            f"/events/roster/{participant.pk}?code={code}",
            {
                "expectedVersion": participant.version,
                "weight": 0.5,
                "included": True,
            },
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["participant"]["weight"], 0.5)

        res = self.client.delete(
            f"/events/participants/update?code={code}&participantId={self.participant.pk}"
        )
        self.assertEqual(res.status_code, 200)

        res = self.client.put(
            f"/events/participants/update/unhide?code={code}&participantId={self.participant.pk}"
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["participant"]["hidden"], 0)

    def test_health_and_missing_or_unknown_event_errors(self):
        live = self.client.get("/health/live")
        self.assertEqual(live.data, {"ok": True})
        self.assertIn("no-store", live["Cache-Control"])
        for path in ["/health", "/health/ready"]:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, {"ok": True, "checks": {"database": "ok"}})
            self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(self.client.get("/api/health").status_code, 404)
        self.authenticate(self.organizer)
        for path in [
            "/events",
            "/events/participants",
            "/events/participants/update",
            "/events/participants/update/unhide",
            "/events/weights",
        ]:
            response = self.client.get(path) if "update" not in path else self.client.put(path)
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/events?code=NOPE").status_code, 404)
        self.assertEqual(self.client.get("/events/participants?code=NOPE").status_code, 404)
        self.assertEqual(
            self.client.put("/events/participants/update?code=NOPE&participantId=x").status_code,
            404,
        )
        self.assertEqual(
            self.client.put(
                "/events/participants/update/unhide?code=NOPE&participantId=x"
            ).status_code,
            404,
        )
        self.assertEqual(self.client.get("/events/weights?code=NOPE").status_code, 404)

    @patch("apps.scheduling.views.health.connection.cursor")
    def test_readiness_reports_database_failure_without_details(self, cursor):
        cursor.side_effect = DatabaseError("database credentials must not leak")

        for path in ["/health", "/health/ready"]:
            with self.assertLogs("apps.scheduling.views.health", level="WARNING") as logs:
                response = self.client.get(path)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(
                response.data,
                {"ok": False, "checks": {"database": "unavailable"}},
            )
            self.assertNotContains(response, "credentials", status_code=503)
            self.assertIn("readiness_check_failed", logs.output[0])

    def test_event_create_validation_and_defaults(self):
        self.authenticate(self.organizer)
        invalid_payloads = [
            ({}, "Name is required"),
            ({"name": "x" * 201}, "Event name too long"),
            ({"name": "Planning", "startHour": 9}, "Use startTime"),
            ({"name": "Planning", "startTime": 9}, "HH:MM"),
            (
                {"name": "Planning", "startTime": "12:00", "endTime": "12:00"},
                "must be different",
            ),
            (
                {
                    "name": "Planning",
                    "startTime": "09:10",
                    "endTime": "10:10",
                    "slotMinutes": 30,
                },
                "align to 30-minute",
            ),
            ({"name": "Planning", "slotMinutes": 20}, "slotMinutes must be 15 or 30"),
            ({"name": "Planning", "slotMinutes": True}, "slotMinutes must be 15 or 30"),
            ({"name": "Planning", "days": [7]}, "days must be a non-empty array"),
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
                {
                    "name": "Planning",
                    "daySelectionType": "specific_dates",
                    "specificDates": ["20260708"],
                },
                "specificDates must be ISO date strings",
            ),
            (
                {
                    "name": "Planning",
                    "daySelectionType": "specific_dates",
                    "specificDates": ["2026-07-08", "2026-07-08"],
                },
                "must not contain duplicates",
            ),
            (
                {
                    "name": "Planning",
                    "daySelectionType": "specific_dates",
                    "specificDates": [f"2026-07-{day:02d}" for day in range(1, 32)]
                    + ["2026-08-01"],
                },
                "at most",
            ),
            (
                {
                    "name": "Planning",
                    "startTime": "00:00",
                    "endTime": "23:45",
                    "slotMinutes": 15,
                    "daySelectionType": "specific_dates",
                    "specificDates": [f"2026-07-{day:02d}" for day in range(1, 12)],
                },
                "at most 1000 availability slots",
            ),
            (
                {"name": "Planning", "participantViewPermission": "everybody"},
                "Invalid participantViewPermission",
            ),
        ]
        for payload, message in invalid_payloads:
            with self.subTest(message=message):
                response = self.client.post("/events", payload, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertIn(message, response.data["error"])

        response = self.client.post(
            "/events",
            {"name": "Virtual", "mode": "virtual"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["event"]["location"], "")
        self.assertIsNone(response.data["event"]["responseDeadline"])
        self.assertTrue(response.data["event"]["remindersEnabled"])
        self.assertEqual(response.data["event"]["reminderHoursBefore"], 24)

        response = self.client.post(
            "/events",
            {
                "name": "Dates",
                "startTime": "09:00",
                "endTime": "10:00",
                "slotMinutes": 30,
                "daySelectionType": "specific_dates",
                "specificDates": ["2026-07-08", "2026-07-09"],
                "participantViewPermission": "all",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        event = Event.objects.get(code=response.data["event"]["code"])
        self.assertEqual(expected_availability_length(event), 4)
        data = api_event(event)
        self.assertEqual(data["specificDates"], ["2026-07-08", "2026-07-09"])
        self.assertEqual(data["slotCount"], 4)
        self.assertEqual([group["date"] for group in data["slotGroups"]], data["specificDates"])

        cross_midnight = self.client.post(
            "/events",
            {
                "name": "Overnight",
                "startTime": "23:00",
                "endTime": "01:00",
                "slotMinutes": 30,
                "days": [1, 3],
            },
            format="json",
        )
        self.assertEqual(cross_midnight.status_code, 201)
        self.assertTrue(cross_midnight.data["event"]["crossesMidnight"])
        self.assertEqual(cross_midnight.data["event"]["slotCount"], 8)

        fifteen_minutes = self.client.post(
            "/events",
            {
                "name": "Quarter hours",
                "startTime": "09:15",
                "endTime": "10:15",
                "slotMinutes": 15,
                "daySelectionType": "specific_dates",
                "specificDates": ["2026-07-20", "2026-07-21"],
            },
            format="json",
        )
        self.assertEqual(fifteen_minutes.status_code, 201)
        self.assertEqual(fifteen_minutes.data["event"]["slotCount"], 8)
        self.assertEqual(
            [
                slot["index"]
                for group in fifteen_minutes.data["event"]["slotGroups"]
                for slot in group["slots"]
            ],
            list(range(8)),
        )

    def test_event_code_generation_failure(self):
        self.authenticate(self.organizer)
        with patch(
            "apps.scheduling.services.events.mutations.generate_event_code",
            return_value="DUPLICAT",
        ):
            Event.objects.create(
                code="DUPLICAT",
                name="Existing",
                organizer=self.organizer,
                days=[1],
                start_minutes=9 * 60,
                end_minutes=10 * 60,
            )
            response = self.client.post("/events", {"name": "New"}, format="json")
        self.assertEqual(response.status_code, 500)

    def test_participant_join_edge_cases_and_include_hidden(self):
        code = self.create_event()
        event = Event.objects.get(code=code)
        nameless = get_user_model().objects.create_user(password="password123", is_active=True)
        self.authenticate(nameless)
        with patch.object(nameless.__class__, "display_name", return_value=""):
            response = self.client.post(f"/events/participants?code={code}", {}, format="json")
            self.assertEqual(response.status_code, 400)
        with patch.object(nameless.__class__, "display_name", return_value="x" * 101):
            response = self.client.post(f"/events/participants?code={code}", {}, format="json")
            self.assertEqual(response.status_code, 400)

        self.authenticate(self.participant)
        response = self.client.post("/events/participants", {}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/events/participants?code=NOPE", {}, format="json")
        self.assertEqual(response.status_code, 404)

        self.client.post(f"/events/participants?code={code}", {}, format="json")
        participant = Participant.objects.get(member=self.participant, event=event)
        participant.participant_name = "Changed"
        participant.save(update_fields=["participant_name"])
        repeat = self.client.post(f"/events/participants?code={code}", {}, format="json")
        self.assertEqual(repeat.status_code, 200)
        participant.refresh_from_db()
        self.assertEqual(participant.participant_name, "Part Person")

        self.authenticate(self.organizer)
        self.client.delete(
            f"/events/participants/update?code={code}&participantId={self.participant.pk}"
        )
        hidden = self.client.get(f"/events/participants?code={code}")
        self.assertEqual(hidden.data["participants"], [])
        included = self.client.get(f"/events/participants?code={code}&includeHidden=true")
        self.assertEqual(len(included.data["participants"]), 1)
        organizer_join = self.client.post(f"/events/participants?code={code}", {}, format="json")
        self.assertEqual(organizer_join.status_code, 201)

    def test_participant_update_validation_and_noop(self):
        code = self.create_event()
        self.authenticate(self.participant)
        self.client.post(f"/events/participants?code={code}", {}, format="json")
        base = f"/events/participants/update?code={code}&participantId={self.participant.pk}"

        response = self.client.put(base, {"availabilityInperson": "[bad"}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.put(base, {"availabilityInperson": "not-list"}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.put(base, {"availabilityInperson": [1]}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.put(base, {"availabilityInperson": [2] * 8}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.put(base, {}, format="json")
        self.assertEqual(response.status_code, 200)
        other = create_member("missing-participant@example.com")
        response = self.client.put(
            f"/events/participants/update?code={code}&participantId={other.pk}",
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
            f"/events/participants/update?code={code}&participantId={other.pk}"
        )
        self.assertEqual(response.status_code, 404)

    def test_unhide_and_weight_validation_errors(self):
        code = self.create_event()
        self.authenticate(self.participant)
        self.client.post(f"/events/participants?code={code}", {}, format="json")

        self.authenticate(self.participant)
        response = self.client.put(
            f"/events/participants/update/unhide?code={code}&participantId={self.participant.pk}"
        )
        self.assertEqual(response.status_code, 403)

        self.authenticate(self.organizer)
        other = create_member("other-unhide@example.com")
        missing = self.client.put(
            f"/events/participants/update/unhide?code={code}&participantId={other.pk}"
        )
        self.assertEqual(missing.status_code, 404)

        self.authenticate(self.participant)
        self.assertEqual(self.client.get(f"/events/weights?code={code}").status_code, 403)

        self.authenticate(self.organizer)
        self.assertEqual(
            self.client.put("/events/weights", {"weights": []}, format="json").status_code,
            405,
        )
        self.assertEqual(
            self.client.put(
                "/events/weights?code=NOPE", {"weights": []}, format="json"
            ).status_code,
            405,
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
                response = self.client.put(f"/events/weights?code={code}", payload, format="json")
                self.assertEqual(response.status_code, 405)

        participant = Participant.objects.get(event__code=code, member=self.participant)
        response = self.client.patch(
            f"/events/roster/{participant.pk}?code={code}",
            {
                "expectedVersion": participant.version,
                "weight": 0.75,
                "included": False,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.get(f"/events/weights?code={code}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["weights"][0]["included"], 0)

        dashboard = self.client.get("/dashboard/events")
        self.assertEqual([event["code"] for event in dashboard.data["organized"]], [code])

    def test_model_strings_and_schedule_helpers(self):
        code = self.create_event()
        event = Event.objects.get(code=code)
        self.authenticate(self.participant)
        participant_response = self.client.post(
            f"/events/participants?code={code}", {}, format="json"
        )
        participant = Participant.objects.get(member=self.participant, event=event)
        UserEvent.objects.get_or_create(member=self.participant, event=event, role="participant")

        self.assertIn(code, str(event))
        self.assertIn(code, str(participant))
        self.assertIn(code, str(UserEvent.objects.get(member=self.participant, event=event)))
        weight = Weight.objects.create(event=event, participant=participant, weight=0.25)
        self.assertIn("0.25", str(weight))
        invitation = EventInvitation.objects.create(
            event=event,
            email="model-string@example.com",
            invited_by=self.organizer,
        )
        self.assertIn("model-string@example.com", str(invitation))
        self.assertEqual(default_availability(event), [0] * 8)
        self.assertEqual(
            validate_availability({"bad": 1}, event, "x"),
            "Invalid x: must be an array",
        )
        self.assertIsNone(
            validate_availability(
                participant_response.data["participant"]["availabilityInperson"],
                event,
                "x",
            )
        )
