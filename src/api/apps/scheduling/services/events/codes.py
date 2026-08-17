"""Random public event codes."""

import secrets
import string

CODE_ALPHABET = string.ascii_uppercase + string.digits


def generate_event_code(length: int = 8) -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))
