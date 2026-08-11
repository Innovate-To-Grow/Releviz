"""Types used by member import services."""

from dataclasses import dataclass, field


@dataclass
class ImportResult:
    """Result of a member import operation."""

    success: bool
    created_count: int = 0
    updated_count: int = 0
    skipped_count: int = 0
    errors: list[str] = field(default_factory=list)
    details: list[dict] = field(default_factory=list)
