import importlib
import uuid
from types import SimpleNamespace
from unittest.mock import Mock

from django.test import SimpleTestCase

normalize_singletons = importlib.import_module(
    "apps.authn.migrations.0017_auth_security_invariants"
).normalize_singletons


class AuthSecurityInvariantMigrationTest(SimpleTestCase):
    def test_rsa_dedupe_preserves_newest_created_key(self):
        newest_created = SimpleNamespace(pk=uuid.UUID(int=2))
        active_names = Mock()
        active_names.iterator.return_value = iter(["auth-encryption"])
        name_filter = Mock()
        ordered_keys = Mock()
        ordered_keys.first.return_value = newest_created
        name_filter.order_by.return_value = ordered_keys

        rsa_objects = Mock()
        rsa_objects.filter.side_effect = [active_names, name_filter]
        active_names.order_by.return_value.values_list.return_value.distinct.return_value = (
            active_names
        )
        rsa_model = SimpleNamespace(objects=rsa_objects)

        enabled_filter = Mock()
        enabled_ordered = Mock()
        enabled_ordered.first.return_value = None
        enabled_filter.order_by.return_value = enabled_ordered
        fallback_ordered = Mock()
        fallback_ordered.first.return_value = None
        member_objects = Mock()
        member_objects.filter.return_value = enabled_filter
        member_objects.order_by.return_value = fallback_ordered
        member_sync_model = SimpleNamespace(objects=member_objects)

        historical_apps = Mock()
        historical_apps.get_model.side_effect = [rsa_model, member_sync_model]

        normalize_singletons(historical_apps, None)

        name_filter.order_by.assert_called_once_with("-created_at", "-pk")
        ordered_keys.exclude.assert_called_once_with(pk=newest_created.pk)
