from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.serializers import ProfileSerializer


class SessionView(APIView):
    """Return the authenticated member state used to bootstrap the frontend."""

    permission_classes = [IsAuthenticated]

    # noinspection PyMethodMayBeStatic
    def get(self, request):
        member = request.user
        user = dict(ProfileSerializer(instance=member).data)
        user.update(
            {
                "is_staff": member.is_staff,
            }
        )
        requires_profile_completion = bool(member.requires_profile_completion)
        return Response(
            {
                "user": user,
                "requires_profile_completion": requires_profile_completion,
                "next_step": "complete_profile" if requires_profile_completion else "account",
            },
            status=status.HTTP_200_OK,
        )
