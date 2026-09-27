"""Preview row views, the preview summary's four-way split, the sample row, and header aliases."""

import io

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase
from openpyxl import Workbook
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.models import Event, UserEvent
from apps.scheduling.services.roster_imports.mapping import auto_mapping


class RosterImportPreviewViewTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.organizer = create_member("preview-owner@example.com", "Event", "Owner")
        self.event = Event.objects.create(
            code="PREVROWS",
            name="Preview rows",
            organizer=self.organizer,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        UserEvent.objects.create(member=self.organizer, event=self.event, role="organizer")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(self.organizer)}")

    def paste(self, content):
        response = self.client.post(
            f"/events/roster-imports?code={self.event.code}",
            {"sourceType": "paste", "pastedText": content},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        return response.data["import"]

    def upload(self, workbook):
        output = io.BytesIO()
        workbook.save(output)
        response = self.client.post(
            f"/events/roster-imports?code={self.event.code}",
            {"file": SimpleUploadedFile("roster.xlsx", output.getvalue())},
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        return response.data["import"]

    def update(self, import_id, payload):
        response = self.client.put(
            f"/events/roster-imports/{import_id}?code={self.event.code}",
            payload,
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response.data["import"]

    def rows(self, import_id, query=""):
        return self.client.get(
            f"/events/roster-imports/{import_id}/rows?code={self.event.code}{query}"
        )

    def test_show_narrows_the_rows_and_pages_after_narrowing(self):
        preview = self.paste(
            "name,email\n"
            "Ada,ada@example.com\n"
            "Bad,not-an-email\n"
            "Ada,ada@example.com\n"
            "Dan,dan@example.com\n"
        )
        import_id = preview["id"]
        self.assertEqual(
            preview["summary"],
            {
                "total": 4,
                "selected": 3,
                "valid": 2,
                "invalid": 1,
                "conflicts": 0,
                "ready": 2,
                "needsFix": 1,
                "mergedDuplicates": 1,
                "skipped": 0,
            },
        )
        dan = next(row for row in self.rows(import_id).data["rows"] if row["name"] == "Dan")
        updated = self.update(import_id, {"rowUpdates": [{"id": dan["id"], "selected": False}]})
        # Dan was left out on purpose; Ada's second row folded into her first.
        self.assertEqual(updated["summary"]["skipped"], 1)
        self.assertEqual(updated["summary"]["mergedDuplicates"], 1)
        self.assertEqual(updated["summary"]["ready"], 1)
        self.assertEqual(updated["summary"]["needsFix"], 1)

        for query, names in [
            ("", ["Ada", "Bad", "Ada", "Dan"]),
            ("&show=all", ["Ada", "Bad", "Ada", "Dan"]),
            ("&show=", ["Ada", "Bad", "Ada", "Dan"]),
            ("&show=needs_fix", ["Bad"]),
            ("&show=skipped", ["Ada", "Dan"]),
        ]:
            with self.subTest(query=query):
                response = self.rows(import_id, query)
                self.assertEqual(response.status_code, 200, response.data)
                self.assertEqual([row["name"] for row in response.data["rows"]], names)
                self.assertEqual(response.data["pagination"]["total"], len(names))

        # Pages are cut after the view is applied.
        page = self.rows(import_id, "&show=skipped&pageSize=1&page=2")
        self.assertEqual(page.status_code, 200, page.data)
        self.assertEqual([row["name"] for row in page.data["rows"]], ["Dan"])
        self.assertEqual(
            page.data["pagination"], {"page": 2, "pageSize": 1, "total": 2, "pages": 2}
        )

        invalid = self.rows(import_id, "&show=bogus")
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.data["error"], "show is invalid.")

        # Once the address is fixed nothing needs a hand any more.
        bad = next(row for row in self.rows(import_id).data["rows"] if row["name"] == "Bad")
        fixed = self.update(
            import_id, {"rowUpdates": [{"id": bad["id"], "email": "bad@example.com"}]}
        )
        self.assertEqual(fixed["summary"]["needsFix"], 0)
        self.assertEqual(fixed["summary"]["ready"], 2)
        self.assertEqual(self.rows(import_id, "&show=needs_fix").data["pagination"]["total"], 0)

    def test_sample_row_is_the_first_data_row_of_the_selected_worksheet(self):
        pasted = self.paste("name,email\n\nAda,ada@example.com\nBob,bob@example.com\n")
        self.assertEqual(pasted["sampleRow"], ["Ada", "ada@example.com"])
        # Moving the header down moves the sample with it.
        moved = self.update(pasted["id"], {"headerRow": 3})
        self.assertEqual(moved["sampleRow"], ["Bob", "bob@example.com"])
        self.assertEqual(self.rows(pasted["id"]).data["import"]["sampleRow"], moved["sampleRow"])

        header_only = self.paste("name,email\n")
        self.assertIsNone(header_only["sampleRow"])
        self.assertEqual(header_only["summary"]["total"], 0)

        workbook = Workbook()
        first = workbook.active
        first.title = "Faculty"
        first.append(["name", "email", "weight", "note"])
        first.append(["Ada", "ada@example.com", 0.5, 5])
        second = workbook.create_sheet("Students")
        second.append(["name", "email"])
        uploaded = self.upload(workbook)
        # Two worksheets: none selected yet, so no sample either.
        self.assertIsNone(uploaded["selectedWorksheet"])
        self.assertIsNone(uploaded["sampleRow"])
        faculty = self.update(uploaded["id"], {"worksheet": "Faculty"})
        self.assertEqual(faculty["sampleRow"], ["Ada", "ada@example.com", "0.5", "5"])
        students = self.update(uploaded["id"], {"worksheet": "Students"})
        self.assertIsNone(students["sampleRow"])


class RosterImportHeaderAliasTests(SimpleTestCase):
    def test_mail_organization_and_tel_name_their_fields(self):
        self.assertEqual(
            auto_mapping(["Mail", "Organization", "Tel", "Name"]),
            {"email": 0, "group": 1, "phone": 2, "name": 3},
        )
        self.assertEqual(
            auto_mapping(["Full name", "MAILS", "Organizations", "tels"]),
            {"name": 0, "email": 1, "group": 2, "phone": 3},
        )
