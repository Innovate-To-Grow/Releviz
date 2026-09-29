"""The administrator toggle and Django permissions describe the same role."""

from django.test import TestCase

from apps.authn.models import Member


class AdministratorRoleTests(TestCase):
    def test_either_legacy_admin_flag_creates_the_same_administrator(self):
        for flags in (
            {"is_staff": True},
            {"is_superuser": True},
            {"is_staff": True, "is_superuser": True},
        ):
            with self.subTest(flags=flags):
                member = Member.objects.create_user(**flags)
                member.refresh_from_db()
                self.assertTrue(member.is_staff)
                self.assertTrue(member.is_superuser)
                self.assertTrue(member.has_perm("authn.change_member"))
                self.assertTrue(member.has_module_perms("scheduling"))

    def test_regular_and_temporary_members_are_not_administrators(self):
        for level in Member.AccessLevel:
            with self.subTest(level=level):
                member = Member.objects.create_user(access_level=level)
                self.assertFalse(member.is_staff)
                self.assertFalse(member.is_superuser)
                self.assertFalse(member.has_perm("authn.change_member"))
                self.assertFalse(member.can_access_app("authn"))

    def test_partial_promotion_grants_django_permissions(self):
        member = Member.objects.create_user()
        self.assertFalse(member.has_perm("authn.change_member"))
        member.is_staff = True
        member.save(update_fields=["is_staff"])
        member.refresh_from_db()
        self.assertTrue(member.is_superuser)
        self.assertTrue(member.has_perm("authn.change_member"))

    def test_full_and_partial_demotion_clear_cached_django_permissions(self):
        for update_fields in (None, ["is_staff"]):
            with self.subTest(update_fields=update_fields):
                member = Member.objects.create_user(is_staff=True)
                self.assertIn("authn.change_member", member.get_all_permissions())
                member.is_staff = False
                member.save(update_fields=update_fields)
                self.assertFalse(member.is_superuser)
                self.assertFalse(member.has_perm("authn.change_member"))
                self.assertFalse(member.has_module_perms("authn"))
                member.refresh_from_db()
                self.assertFalse(member.is_staff)
                self.assertFalse(member.is_superuser)

    def test_unrelated_partial_saves_do_not_restore_a_stale_admin_role(self):
        stale = Member.objects.create_user(is_staff=True)
        current = Member.objects.get(pk=stale.pk)
        current.is_staff = False
        current.save(update_fields=["is_staff"])
        stale.first_name = "Updated"
        stale.save(update_fields=["first_name"])
        stale.refresh_from_db()
        self.assertEqual(stale.first_name, "Updated")
        self.assertFalse(stale.is_staff)
        self.assertFalse(stale.is_superuser)

    def test_compatibility_only_save_uses_the_current_database_role(self):
        stale = Member.objects.create_user(is_staff=True)
        current = Member.objects.get(pk=stale.pk)
        current.is_staff = False
        current.save(update_fields=["is_staff"])
        stale.save(update_fields=["is_superuser"])
        self.assertFalse(stale.is_staff)
        self.assertFalse(stale.is_superuser)
        stale.refresh_from_db()
        self.assertFalse(stale.is_superuser)

    def test_legacy_superuser_flag_cannot_create_a_separate_role(self):
        for is_admin in (False, True):
            for update_fields in (None, ["is_superuser"]):
                with self.subTest(is_admin=is_admin, update_fields=update_fields):
                    member = Member.objects.create_user(is_staff=is_admin)
                    member.is_superuser = not is_admin
                    member.save(update_fields=update_fields)
                    member.refresh_from_db()
                    self.assertEqual(member.is_staff, is_admin)
                    self.assertEqual(member.is_superuser, is_admin)

    def test_deferred_profile_save_does_not_load_or_write_role_fields(self):
        member = Member.objects.create_user(is_staff=True)
        deferred = Member.objects.only("first_name").get(pk=member.pk)
        member.is_staff = False
        member.save(update_fields=["is_staff"])
        deferred.first_name = "Updated"
        with self.assertNumQueries(1):
            deferred.save()
        member.refresh_from_db()
        self.assertEqual(member.first_name, "Updated")
        self.assertFalse(member.is_staff)
        self.assertFalse(member.is_superuser)

    def test_deferred_admin_toggle_updates_both_flags(self):
        member = Member.objects.create_user()
        deferred = Member.objects.only("is_staff").get(pk=member.pk)
        deferred.is_staff = True
        deferred.save()
        member.refresh_from_db()
        self.assertTrue(member.is_staff)
        self.assertTrue(member.is_superuser)

    def test_deferred_compatibility_flag_cannot_promote_a_regular_member(self):
        member = Member.objects.create_user()
        deferred = Member.objects.only("is_superuser").get(pk=member.pk)
        deferred.is_superuser = True
        deferred.save()
        self.assertFalse(deferred.is_staff)
        self.assertFalse(deferred.is_superuser)
        member.refresh_from_db()
        self.assertFalse(member.is_superuser)

    def test_empty_update_fields_remains_a_noop(self):
        member = Member.objects.create_user(is_staff=True)
        member.is_staff = False
        with self.assertNumQueries(0):
            member.save(update_fields=[])
        member.refresh_from_db()
        self.assertTrue(member.is_staff)
        self.assertTrue(member.is_superuser)

    def test_inactive_administrators_have_no_admin_permissions(self):
        member = Member.objects.create_user(is_staff=True, is_active=False)
        self.assertFalse(member.has_perm("authn.change_member"))
        self.assertFalse(member.has_module_perms("authn"))
        self.assertFalse(member.can_access_app("authn"))
