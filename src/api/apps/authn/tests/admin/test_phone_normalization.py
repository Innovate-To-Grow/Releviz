"""Coverage for authn.admin.members.contact.normalization helpers."""

import datetime

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.authn.admin.members.contact.normalization import (
    _attendee_name,
    _build_registration_phone_changes,
    apply_phone_changes,
    build_normalization_message,
    compute_phone_changes,
)
from apps.authn.models import ContactPhone
from apps.event.models import Event, EventRegistration, Ticket

Member = get_user_model()


def _member(first="A", last="B"):
    return Member.objects.create_user(password="StrongPass123!", first_name=first, last_name=last)


class BuildNormalizationMessageTests(TestCase):
    def test_all_parts(self):
        msg = build_normalization_message(2, 1, 3)
        self.assertIn("2 phone(s) normalized", msg)
        self.assertIn("1 duplicate(s) removed", msg)
        self.assertIn("3 event registration phone(s) cleaned", msg)

    def test_no_changes(self):
        self.assertEqual(build_normalization_message(0, 0, 0), "No changes needed.")


class ComputeAndApplyPhoneChangesTests(TestCase):
    def _store_raw(self, member, raw, region):
        # Write the raw (un-normalized) value directly, bypassing model.clean().
        phone = ContactPhone(member=member, phone_number=raw, region=region)
        # avoid full_clean() normalization by using a bare save
        ContactPhone.objects.bulk_create([phone])
        return phone

    def test_compute_flags_changed_and_duplicate(self):
        m1 = _member()
        m2 = _member(first="C", last="D")
        # Both carry the "1" country-code prefix (stored differently) so each normalizes to
        # 1-US:2095551234 -> the second is flagged as a duplicate of the first.
        self._store_raw(m1, "12095551234", "1-US")
        self._store_raw(m2, "+12095551234", "1-US")

        phone_changes, reg_changes = compute_phone_changes()
        self.assertEqual(len(phone_changes), 2)
        self.assertTrue(any(c["changed"] for c in phone_changes))
        self.assertTrue(any(c["is_duplicate"] for c in phone_changes))
        self.assertEqual(reg_changes, [])

    def test_apply_updates_and_deletes(self):
        m1 = _member()
        m2 = _member(first="C", last="D")
        self._store_raw(m1, "12095551234", "1-US")
        self._store_raw(m2, "+12095551234", "1-US")

        phone_changes, reg_changes = compute_phone_changes()
        updated, deleted, regs = apply_phone_changes(phone_changes, reg_changes)
        # First normalizes (country code stripped); second is a duplicate -> deleted.
        self.assertEqual(updated, 1)
        self.assertEqual(deleted, 1)
        self.assertEqual(regs, 0)
        self.assertTrue(ContactPhone.objects.filter(phone_number="2095551234").exists())


class RegistrationPhoneChangesTests(TestCase):
    def setUp(self):
        self.member = _member()
        self.event = Event.objects.create(
            name="Demo",
            location="Online",
            date=datetime.date(2030, 1, 1),
            end_date=datetime.date(2030, 1, 1),
            description="d",
        )
        self.ticket = Ticket.objects.create(event=self.event, name="GA")

    def _registration(self, phone):
        return EventRegistration.objects.create(
            member=self.member,
            event=self.event,
            ticket=self.ticket,
            attendee_first_name="Jane",
            attendee_last_name="Doe",
            attendee_phone=phone,
        )

    def test_registration_phone_normalized(self):
        self._registration("(209) 555-1234")
        changes = _build_registration_phone_changes()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["new_phone"], "+2095551234")
        self.assertEqual(changes[0]["attendee"], "Jane Doe")

    def test_registration_already_clean_skipped(self):
        self._registration("+12095551234")
        changes = _build_registration_phone_changes()
        self.assertEqual(changes, [])

    def test_apply_updates_registration_phone(self):
        reg = self._registration("(209) 555-9999")
        _phone_changes, reg_changes = compute_phone_changes()
        updated, deleted, regs = apply_phone_changes([], reg_changes)
        self.assertEqual(regs, 1)
        reg.refresh_from_db()
        self.assertEqual(reg.attendee_phone, "+2095559999")

    def test_attendee_name_falls_back_to_dash(self):
        # An (unsaved) registration with blank names -> "-" (the model's save() would
        # otherwise backfill names from the member).
        reg = EventRegistration(attendee_first_name="", attendee_last_name="")
        self.assertEqual(_attendee_name(reg), "-")
