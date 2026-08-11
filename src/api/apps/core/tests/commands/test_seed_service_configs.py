"""Tests for the seed_service_configs management command."""

from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase

from apps.authn.models import ContactEmail, Member
from apps.core.models import AWSCredentialConfig, EmailServiceConfig


class SeedServiceConfigsTest(TestCase):
    def _run(self):
        out = StringIO()
        call_command("seed_service_configs", stdout=out)
        return out.getvalue()

    def test_creates_email_config_when_absent(self):
        output = self._run()
        config = EmailServiceConfig.objects.get(name="Production")
        self.assertTrue(config.is_active)
        self.assertIn("Created skeleton active EmailServiceConfig 'Production'.", output)

    def test_skips_email_config_when_present(self):
        EmailServiceConfig.objects.create(name="Existing", is_active=True)
        output = self._run()
        self.assertIn("EmailServiceConfig already exists", output)
        self.assertFalse(EmailServiceConfig.objects.filter(name="Production").exists())

    def test_aws_skipped_when_no_env_credentials(self):
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("AWS_ACCESS_KEY_ID", None)
            os.environ.pop("AWS_SECRET_ACCESS_KEY", None)
            output = self._run()
        self.assertIn("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set", output)
        self.assertFalse(AWSCredentialConfig.objects.exists())

    def test_aws_created_when_env_credentials_present(self):
        env = {
            "AWS_ACCESS_KEY_ID": "AKIATEST",
            "AWS_SECRET_ACCESS_KEY": "secret",
            "AWS_DEFAULT_REGION": "eu-west-1",
        }
        with patch.dict("os.environ", env, clear=False):
            output = self._run()
        config = AWSCredentialConfig.objects.get(name="Production")
        self.assertTrue(config.is_active)
        self.assertEqual(config.access_key_id, "AKIATEST")
        self.assertEqual(config.secret_access_key, "secret")
        self.assertEqual(config.default_region, "eu-west-1")
        self.assertIn("Created active AWSCredentialConfig 'Production'.", output)

    def test_aws_skipped_when_config_exists(self):
        AWSCredentialConfig.objects.create(name="Existing", is_active=True)
        env = {"AWS_ACCESS_KEY_ID": "AKIATEST", "AWS_SECRET_ACCESS_KEY": "secret"}
        with patch.dict("os.environ", env, clear=False):
            output = self._run()
        self.assertIn("AWSCredentialConfig already exists", output)
        self.assertFalse(AWSCredentialConfig.objects.filter(name="Production").exists())

    def test_creates_contact_email_for_staff_member(self):
        member = Member.objects.create_superuser(password="x", first_name="Staff", last_name="One")
        ContactEmail.objects.create(
            member=member,
            email_address="staff-one@example.com",
            email_type="primary",
            verified=True,
        )
        # get_primary_email should resolve; delete the auto contact to force creation path.
        ContactEmail.objects.filter(member=member).delete()
        with patch.object(Member, "get_primary_email", return_value="staff-one@example.com"):
            output = self._run()
        self.assertTrue(ContactEmail.objects.filter(email_address="staff-one@example.com").exists())
        self.assertIn("Created verified ContactEmail for staff 'staff-one@example.com'.", output)

    def test_skips_staff_without_primary_email(self):
        Member.objects.create(first_name="No", last_name="Email", is_staff=True, is_active=True)
        with patch.object(Member, "get_primary_email", return_value=None):
            output = self._run()
        # The staff branch produced no ContactEmail creation message.
        self.assertNotIn("Created verified ContactEmail for staff", output)

    def test_existing_contact_email_skipped(self):
        member = Member.objects.create(first_name="Has", last_name="Email", is_staff=True, is_active=True)
        ContactEmail.objects.create(
            member=member,
            email_address="has-email@example.com",
            email_type="primary",
            verified=True,
        )
        with patch.object(Member, "get_primary_email", return_value="has-email@example.com"):
            output = self._run()
        self.assertIn("ContactEmail already exists for 'has-email@example.com'", output)
