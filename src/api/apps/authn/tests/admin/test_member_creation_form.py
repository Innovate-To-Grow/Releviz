from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from apps.authn.admin.members.forms import MemberChangeForm, MemberCreationForm
from apps.authn.models import Member


class MemberCreationFormPasswordTest(TestCase):
    def test_empty_passwords_valid_and_sets_unusable_password(self):
        form = MemberCreationForm(
            {
                "first_name": "No",
                "last_name": "Password",
                "password1": "",
                "password2": "",
                "is_active": "on",
            }
        )
        self.assertTrue(form.is_valid(), form.errors)
        user: Member = form.save()
        self.assertIsNotNone(user.pk)
        self.assertFalse(user.has_usable_password())

    def test_mismatched_passwords_invalid(self):
        form = MemberCreationForm(
            {
                "first_name": "A",
                "last_name": "B",
                "password1": "onepassword123",
                "password2": "otherpassword123",
                "is_active": "on",
            }
        )
        self.assertFalse(form.is_valid())

    def test_matching_passwords_sets_usable(self):
        form = MemberCreationForm(
            {
                "first_name": "A",
                "last_name": "B",
                "password1": "StrongPass123!",
                "password2": "StrongPass123!",
                "is_active": "on",
            }
        )
        self.assertTrue(form.is_valid(), form.errors)
        user = form.save()
        self.assertTrue(user.has_usable_password())


class MemberChangeFormProfileImageTest(TestCase):
    def _member(self):
        return Member.objects.create_user(
            first_name="Avatar",
            last_name="User",
            password="StrongPass123!",
            profile_image="data:image/png;base64,old-image",
        )

    def _form_data(self, member, **overrides):
        data = {
            "password": member.password,
            "first_name": member.first_name,
            "middle_name": member.middle_name or "",
            "last_name": member.last_name,
            "organization": member.organization or "",
            "title": member.title or "",
            "profile_image": "",
            "is_active": "on" if member.is_active else "",
            "is_staff": "on" if member.is_staff else "",
            "is_superuser": "on" if member.is_superuser else "",
            "groups": [],
            "user_permissions": [],
            "last_login": "",
            "date_joined": member.date_joined.isoformat(),
        }
        data.update(overrides)
        return data

    def test_empty_profile_image_input_preserves_existing_image(self):
        member = self._member()

        form = MemberChangeForm(data=self._form_data(member, first_name="Updated"), files={}, instance=member)

        self.assertTrue(form.is_valid(), form.errors)
        saved = form.save()
        self.assertEqual(saved.first_name, "Updated")
        self.assertEqual(saved.profile_image, "data:image/png;base64,old-image")

    def test_omitted_profile_image_input_preserves_existing_image(self):
        member = self._member()
        data = self._form_data(member, first_name="Omitted")
        data.pop("profile_image")

        form = MemberChangeForm(data=data, files={}, instance=member)

        self.assertTrue(form.is_valid(), form.errors)
        saved = form.save()
        self.assertEqual(saved.first_name, "Omitted")
        self.assertEqual(saved.profile_image, "data:image/png;base64,old-image")

    def test_uploaded_profile_image_replaces_existing_image(self):
        member = self._member()
        upload = SimpleUploadedFile("avatar.png", b"new-image", content_type="image/png")

        form = MemberChangeForm(
            data=self._form_data(member),
            files={"profile_image": upload},
            instance=member,
        )

        self.assertTrue(form.is_valid(), form.errors)
        saved = form.save()
        self.assertEqual(saved.profile_image, "data:image/png;base64,bmV3LWltYWdl")
