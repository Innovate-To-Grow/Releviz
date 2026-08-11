"""
Tests for the "Export selected members as vCard (.vcf)" admin action on
the Member change list.
"""

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings

from apps.authn.models import ContactEmail
from apps.authn.services.members.export_vcf import CRLF, MAX_LINE_OCTETS, _fold

Member = get_user_model()


@override_settings(ROOT_URLCONF="config.routing.urls")
class MemberVCardExportActionTest(TestCase):
    CHANGELIST_URL = "/admin/authn/member/"

    def setUp(self):
        cache.clear()
        self.admin = Member.objects.create_superuser(
            password="admin123",
            first_name="Admin",
            last_name="User",
            is_staff=True,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.admin,
            email_address="admin@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_login(self.admin)

    def tearDown(self):
        cache.clear()

    def _run_export(self, member_ids):
        return self.client.post(
            self.CHANGELIST_URL,
            {
                "action": "export_members_to_vcard",
                "_selected_action": [str(pk) for pk in member_ids],
                "select_across": "0",
                "index": "0",
            },
            follow=False,
        )

    def test_rich_member_produces_full_vcard(self):
        member = Member.objects.create_user(
            password="t1",
            first_name="Jane",
            middle_name="Q",
            last_name="Doe",
            organization="Acme Corp",
            title="Engineer",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=member,
            email_address="jane.primary@example.com",
            email_type="primary",
            verified=True,
        )
        ContactEmail.objects.create(
            member=member,
            email_address="jane.secondary@example.com",
            email_type="secondary",
            verified=False,
        )

        resp = self._run_export([member.pk])

        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp["Content-Type"].startswith("text/vcard"))
        disposition = resp["Content-Disposition"]
        self.assertIn("attachment;", disposition)
        self.assertIn('filename="members_export_', disposition)
        self.assertTrue(disposition.rstrip('"').endswith(".vcf"))

        body = resp.content.decode("utf-8")
        self.assertIn("BEGIN:VCARD", body)
        self.assertIn("VERSION:3.0", body)
        self.assertIn("END:VCARD", body)
        self.assertIn("FN:Jane Q Doe", body)
        self.assertIn("N:Doe;Jane;Q;;", body)
        self.assertIn("ORG:Acme Corp", body)
        self.assertIn("TITLE:Engineer", body)
        self.assertIn("EMAIL;TYPE=INTERNET,PREF:jane.primary@example.com", body)
        self.assertIn("EMAIL;TYPE=INTERNET:jane.secondary@example.com", body)
        self.assertIn(f"UID:urn:uuid:{member.id}", body)
        # CRLF line endings
        self.assertIn("\r\n", body)

    def test_multiple_members_each_get_a_card(self):
        m1 = Member.objects.create_user(password="t1", first_name="Ann", last_name="One", is_active=True)
        ContactEmail.objects.create(member=m1, email_address="ann@example.com", email_type="primary")
        m2 = Member.objects.create_user(password="t2", first_name="Bob", last_name="Two", is_active=True)
        ContactEmail.objects.create(member=m2, email_address="bob@example.com", email_type="primary")

        resp = self._run_export([m1.pk, m2.pk])
        self.assertEqual(resp.status_code, 200)

        body = resp.content.decode("utf-8")
        self.assertEqual(body.count("BEGIN:VCARD"), 2)
        self.assertEqual(body.count("END:VCARD"), 2)
        self.assertIn("FN:Ann One", body)
        self.assertIn("FN:Bob Two", body)

    def test_minimal_member_omits_optional_fields(self):
        member = Member.objects.create_user(password="t1", first_name="Solo", last_name="Person", is_active=True)

        resp = self._run_export([member.pk])
        self.assertEqual(resp.status_code, 200)

        body = resp.content.decode("utf-8")
        self.assertIn("FN:Solo Person", body)
        self.assertIn("N:Person;Solo;;;", body)
        self.assertIn(f"UID:urn:uuid:{member.id}", body)
        # No spurious empty optional lines
        self.assertNotIn("ORG:", body)
        self.assertNotIn("TITLE:", body)
        self.assertNotIn("EMAIL", body)
        self.assertNotIn("TEL", body)
        self.assertNotIn("PHOTO", body)

    def test_special_characters_are_escaped(self):
        member = Member.objects.create_user(
            password="t1",
            first_name="Eve",
            last_name="Smith",
            organization="Acme, Inc.; Ltd",
            title="Lead; Engineer, Backend",
            is_active=True,
        )

        resp = self._run_export([member.pk])
        self.assertEqual(resp.status_code, 200)

        body = resp.content.decode("utf-8")
        self.assertIn("ORG:Acme\\, Inc.\\; Ltd", body)
        self.assertIn("TITLE:Lead\\; Engineer\\, Backend", body)

    def test_profile_image_data_uri_preserves_mime_type(self):
        cases = [
            ("image/png", "PNG", "png-data"),
            ("image/gif", "GIF", "gif-data"),
            ("image/webp", "WEBP", "webp-data"),
            ("image/jpeg", "JPEG", "jpeg-data"),
        ]

        for mime_type, vcard_type, payload in cases:
            with self.subTest(mime_type=mime_type):
                member = Member.objects.create_user(
                    password="t1",
                    first_name=f"Photo{vcard_type}",
                    last_name="Member",
                    profile_image=f"data:{mime_type};base64,{payload}",
                    is_active=True,
                )

                resp = self._run_export([member.pk])

                self.assertEqual(resp.status_code, 200)
                body = resp.content.decode("utf-8")
                self.assertIn(f"PHOTO;ENCODING=b;TYPE={vcard_type}:{payload}", body)

    def test_profile_image_omits_type_when_unknown(self):
        member = Member.objects.create_user(
            password="t1",
            first_name="Unknown",
            last_name="Photo",
            profile_image="data:application/octet-stream;base64,raw-data",
            is_active=True,
        )

        resp = self._run_export([member.pk])

        self.assertEqual(resp.status_code, 200)
        body = resp.content.decode("utf-8")
        self.assertIn("PHOTO;ENCODING=b:raw-data", body)
        self.assertNotIn("PHOTO;ENCODING=b;TYPE=", body)

    def test_fold_preserves_utf8_text_and_line_octet_limit(self):
        line = "ORG:" + ("研究中心" * 30)

        folded = _fold(line)

        self.assertEqual(folded.replace(f"{CRLF} ", ""), line)
        for physical_line in folded.split(CRLF):
            self.assertLessEqual(len(physical_line.encode("utf-8")), MAX_LINE_OCTETS)
