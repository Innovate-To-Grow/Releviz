from collections import Counter
from typing import Any

from django.db import models, router
from django.db.models.deletion import Collector


def collect_cascade_impact(obj: models.Model) -> dict[str, Any]:
    """Enumerate related rows that would be touched by a cascade delete.

    Returns a dict with per-model counts for related rows and a total. The
    target row itself is excluded so the count reflects collateral damage only.
    """
    using = router.db_for_write(obj.__class__, instance=obj)
    collector = Collector(using=using)
    try:
        collector.collect([obj])
    except Exception:
        return {"total": 0, "related": [], "error": "Could not enumerate cascade impact."}
    counts: Counter = Counter()
    for related_model, instances in collector.data.items():
        if related_model is obj.__class__:
            ids = {getattr(inst, "pk", None) for inst in instances}
            ids.discard(obj.pk)
            if ids:
                counts[related_model._meta.label] += len(ids)
            continue
        counts[related_model._meta.label] += len(instances)
    related = [
        {"model": label, "count": count}
        for label, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]
    return {"total": sum(counts.values()), "related": related}


def cascade_summary(base: str | None, cascade: dict[str, Any]) -> str | None:
    total = cascade.get("total") or 0
    if not total:
        return base
    related = cascade.get("related") or []
    parts = [f"{item['count']} {item['model']}" for item in related[:3]]
    suffix = ", ".join(parts)
    if len(related) > 3:
        suffix += ", ..."
    note = f"Cascade will also remove {total} related record(s): {suffix}."
    return f"{base.rstrip('.')}. {note}" if base else note


__all__ = [
    "cascade_summary",
    "collect_cascade_impact",
]
