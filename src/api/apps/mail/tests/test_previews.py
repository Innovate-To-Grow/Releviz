"""Email previews: what a recipient would receive, with nothing sent."""

import uuid

from django.core import mail
from django.test import TestCase, override_settings

from apps.authn.tests.helpers import create_member
from apps.core.services.aws.crypto import encrypt_secret
from apps.mail.models import EmailDeliveryJob, EmailMessageLog, EmailProviderConfig
from apps.mail.previews import display_address, email_preview, job_email_preview
from apps.mail.services import EmailAttachment, enqueue_email_job, send_email_message

ATTACHMENT = EmailAttachment(
    filename="meeting.ics",
    content="BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
    mimetype="text/calendar; charset=utf-8",
)


@override_settings(DEFAULT_FROM_EMAIL="noreply@releviz.test")
class EmailPreviewTests(TestCase):
    def sent_and_previewed(self, **parts):
        """Send ``parts`` for real and preview them; return (sent message, preview)."""

        send_email_message(
            recipients=[" Ada@Example.com "],
            message_type=EmailMessageLog.MessageType.INVITATION,
            **parts,
        )
        preview = email_preview(recipient=" Ada@Example.com ", name="Ada Lovelace", **parts)
        return mail.outbox[-1], preview

    def test_preview_matches_what_the_default_sender_sends(self):
        sent, preview = self.sent_and_previewed(
            subject="Share your\r\navailability",
            body="Plain text part",
            html_body="<!doctype html><p>HTML part</p>",
            attachments=[ATTACHMENT],
        )
        self.assertEqual(
            preview,
            {
                "from": "noreply@releviz.test",
                "replyTo": "",
                "to": "Ada Lovelace <ada@example.com>",
                "subject": "Share your availability",
                "html": "<!doctype html><p>HTML part</p>",
                "text": "Plain text part",
                "attachments": ["meeting.ics"],
            },
        )
        self.assertEqual(sent.from_email, preview["from"])
        self.assertEqual(sent.reply_to, [])
        self.assertEqual(sent.to, ["ada@example.com"])
        self.assertEqual(sent.subject, preview["subject"])
        self.assertEqual(sent.body, preview["text"])
        self.assertEqual(sent.alternatives[0].content, preview["html"])
        self.assertEqual([item[0] for item in sent.attachments], preview["attachments"])

    def test_preview_uses_the_active_provider_and_the_plain_text_fallback(self):
        EmailProviderConfig.objects.create(
            name="Provider",
            from_email="events@example.org",
            reply_to_email="organizers@example.org",
        )
        sent, preview = self.sent_and_previewed(subject="Hello", body="Only text")
        self.assertEqual(preview["from"], "events@example.org")
        self.assertEqual(preview["replyTo"], "organizers@example.org")
        self.assertEqual(sent.from_email, preview["from"])
        self.assertEqual(sent.reply_to, ["organizers@example.org"])
        # Without an HTML part the send wraps the text in the branded layout;
        # the preview shows that same wrapper.
        self.assertIn("Only text", preview["html"])
        self.assertEqual(sent.alternatives[0].content, preview["html"])
        self.assertEqual(preview["attachments"], [])

    def test_display_address_names_the_person_when_known(self):
        self.assertEqual(display_address("ada@example.com"), "ada@example.com")
        self.assertEqual(
            display_address("ada@example.com", "Ada\r\nLovelace"),
            "Ada Lovelace <ada@example.com>",
        )

    @override_settings(FIELD_ENCRYPTION_KEY="unit-test-encryption-key")
    def test_job_preview_shows_the_stored_message(self):
        organizer = create_member("preview-job-owner@example.com")
        job, _created = enqueue_email_job(
            idempotency_key=f"preview-job:{uuid.uuid4()}",
            message_type=EmailMessageLog.MessageType.INVITATION,
            recipient="grace@example.com",
            subject="Stored subject",
            body="Stored text",
            html_body="<p>Stored html</p>",
            attachments=[ATTACHMENT],
            message_id="<stored@releviz.local>",
            member=organizer,
        )
        self.assertEqual(
            job_email_preview(job, name="Grace Hopper"),
            {
                "from": "noreply@releviz.test",
                "replyTo": "",
                "to": "Grace Hopper <grace@example.com>",
                "subject": "Stored subject",
                "html": "<p>Stored html</p>",
                "text": "Stored text",
                "attachments": ["meeting.ics"],
            },
        )

        # Encrypted content is shown decrypted, and a job stored without an
        # HTML part previews with the fallback the send would use.
        EmailDeliveryJob.objects.filter(pk=job.pk).update(
            body=encrypt_secret("Secret text"),
            html_body="",
            content_encrypted=True,
            attachments=[],
        )
        job.refresh_from_db()
        preview = job_email_preview(job)
        self.assertEqual(preview["to"], "grace@example.com")
        self.assertEqual(preview["text"], "Secret text")
        self.assertIn("Secret text", preview["html"])
        self.assertEqual(preview["attachments"], [])
