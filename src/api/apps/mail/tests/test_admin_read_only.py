"""Email logs, delivery requests and delivery jobs are read-only in the admin.

Every field of these audit and outbox records was read-only, yet the admin still
offered Add and Delete, even to a superuser. Nobody adds, edits or deletes one
now. Viewing them and requeueing an uncertain job still work, and the records
still go with the event or member they belong to.
"""

import uuid

from django.contrib import admin
from django.contrib.admin.options import ActionLocation
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse

from apps.authn.models import ContactEmail, Member
from apps.mail.models import EmailDeliveryJob, EmailDeliveryRequest, EmailMessageLog
from apps.mail.services import enqueue_email_job
from apps.scheduling.models import Event


def _url(record, view, *args):
    opts = record._meta
    return reverse(f"admin:{opts.app_label}_{opts.model_name}_{view}", args=args)


@override_settings(ROOT_URLCONF="config.urls", ADMIN_REQUIRE_CONFIRMATION=False)
class MailRecordAdminReadOnlyTests(TestCase):
    def setUp(self):
        self.superuser = Member.objects.create_superuser(
            password="StrongPass123!", first_name="Super", last_name="User", is_active=True
        )
        self.member = Member.objects.create_user(
            password="StrongPass123!", first_name="Rae", last_name="Recipient", is_active=True
        )
        ContactEmail.objects.create(
            member=self.member,
            email_address="recipient@example.com",
            email_type="primary",
            verified=True,
        )
        self.event = Event.objects.create(
            code="MAILRO1",
            name="Read-only mail",
            organizer=self.superuser,
            days=[1],
            start_minutes=9 * 60,
            end_minutes=10 * 60,
        )
        self.job, _created = enqueue_email_job(
            idempotency_key="read-only-job",
            message_type=EmailMessageLog.MessageType.TEST,
            recipient="recipient@example.com",
            subject="Read only",
            body="Body",
            message_id="<read-only-job@releviz.local>",
            event=self.event,
            member=self.member,
        )
        self.log = EmailMessageLog.objects.create(
            message_type=EmailMessageLog.MessageType.TEST,
            recipient="recipient@example.com",
            subject="Read only",
            status=EmailMessageLog.Status.SENT,
            event=self.event,
            delivery_job=self.job,
        )
        self.delivery_request = EmailDeliveryRequest.objects.create(
            event=self.event,
            requested_by=self.superuser,
            operation=EmailDeliveryRequest.Operation.INVITATION,
            idempotency_key=uuid.uuid4(),
            request_fingerprint="f" * 64,
            recipient_count=1,
            created_job_count=1,
        )
        self.delivery_request.jobs.add(self.job)
        self.records = (self.log, self.job, self.delivery_request)
        self.client.force_login(self.superuser)

    def test_nobody_adds_edits_or_deletes_a_record_not_even_a_superuser(self):
        for record in self.records:
            model = type(record)
            with self.subTest(model=model.__name__):
                changelist = self.client.get(_url(record, "changelist"))
                self.assertEqual(changelist.status_code, 200)
                self.assertNotContains(changelist, _url(record, "add"))
                self.assertNotContains(changelist, 'value="delete_selected"')

                self.assertEqual(self.client.get(_url(record, "add")).status_code, 403)
                self.assertEqual(self.client.post(_url(record, "add"), {}).status_code, 403)

                change_url = _url(record, "change", record.pk)
                page = self.client.get(change_url)
                self.assertEqual(page.status_code, 200)
                self.assertNotContains(page, 'name="_save"')
                self.assertNotContains(page, _url(record, "delete", record.pk))
                self.assertEqual(
                    self.client.post(change_url, {"subject": "Edited"}).status_code, 403
                )

                delete_url = _url(record, "delete", record.pk)
                self.assertEqual(self.client.get(delete_url).status_code, 403)
                self.assertEqual(self.client.post(delete_url, {"post": "yes"}).status_code, 403)

                self.client.post(
                    _url(record, "changelist"),
                    {
                        "action": "delete_selected",
                        "index": "0",
                        "post": "yes",
                        "_selected_action": [str(record.pk)],
                    },
                )
                self.assertTrue(model.objects.filter(pk=record.pk).exists())

        self.job.refresh_from_db()
        self.assertEqual(self.job.subject, "Read only")

    def test_mail_staff_still_view_records_and_requeue_an_uncertain_job(self):
        EmailDeliveryJob.objects.filter(pk=self.job.pk).update(
            status=EmailDeliveryJob.Status.UNCERTAIN
        )
        staff = Member.objects.create_user(
            password="StrongPass123!", is_staff=True, is_active=True, admin_apps=["mail"]
        )
        self.client.force_login(staff)
        for record in self.records:
            with self.subTest(model=type(record).__name__):
                self.assertEqual(
                    self.client.get(_url(record, "change", record.pk)).status_code, 200
                )

        changelist = _url(self.job, "changelist")
        self.assertContains(self.client.get(changelist), 'value="retry_uncertain_deliveries"')
        response = self.client.post(
            changelist,
            {
                "action": "retry_uncertain_deliveries",
                "index": "0",
                "_selected_action": [str(self.job.pk)],
            },
            follow=True,
        )

        self.assertContains(response, "1 uncertain email delivery job(s) requeued.")
        self.job.refresh_from_db()
        self.assertEqual(self.job.status, EmailDeliveryJob.Status.RETRY)

    def test_bulk_delete_is_dropped_with_or_without_an_action_location(self):
        request = RequestFactory().get(_url(self.job, "changelist"))
        request.user = self.superuser
        model_admin = admin.site.get_model_admin(EmailDeliveryJob)

        self.assertEqual(list(model_admin.get_actions(request)), ["retry_uncertain_deliveries"])
        self.assertEqual(
            list(model_admin.get_actions(request, action_location=ActionLocation.CHANGE_LIST)),
            ["retry_uncertain_deliveries"],
        )

    def test_records_still_go_with_their_event(self):
        response = self.client.post(_url(self.event, "delete", self.event.pk), {"post": "yes"})

        self.assertEqual(response.status_code, 302)
        self.assertFalse(Event.objects.filter(pk=self.event.pk).exists())
        self.assertFalse(EmailDeliveryJob.objects.filter(pk=self.job.pk).exists())
        self.assertFalse(EmailDeliveryRequest.objects.filter(pk=self.delivery_request.pk).exists())
        # The log keeps what was sent; it only loses the link to the event.
        self.log.refresh_from_db()
        self.assertIsNone(self.log.event_id)

    def test_jobs_still_go_with_their_member(self):
        response = self.client.post(_url(self.member, "delete", self.member.pk), {"post": "yes"})

        self.assertEqual(response.status_code, 302)
        self.assertFalse(Member.objects.filter(pk=self.member.pk).exists())
        self.assertFalse(EmailDeliveryJob.objects.filter(pk=self.job.pk).exists())
