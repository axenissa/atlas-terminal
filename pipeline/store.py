"""Écriture des fichiers JSON lus par le site.

Chaque fichier porte son horodatage, sa source et, en cas d'échec, l'erreur :
le site affiche alors "data unavailable" plutôt qu'une valeur inventée.
"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path

from .config import DATA


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _clean(obj):
    # NaN et infini ne sont pas du JSON valide : on les remplace par null
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if hasattr(obj, "item"):          # scalaires numpy
        return _clean(obj.item())
    return obj


def write(name: str, payload, source: str, errors: dict | None = None, base: Path = DATA) -> Path:
    path = base / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"updated_at": now_iso(), "source": source, "errors": errors or {}, "data": payload}
    path.write_text(json.dumps(_clean(doc), ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                    encoding="utf-8")
    return path


def read(name: str, base: Path = DATA):
    path = base / f"{name}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
