import json
from typing import Any

from django.core.serializers.json import DjangoJSONEncoder


def json_safe(value: Any) -> Any:
    return json.loads(json.dumps(value, cls=DjangoJSONEncoder, default=str))
