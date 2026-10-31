"""Chargement de config/settings.yaml et chemins du projet."""
from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"


@lru_cache(maxsize=1)
def settings() -> dict:
    with open(ROOT / "config" / "settings.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def universe() -> list[dict]:
    return settings()["universe"]


def symbols() -> list[str]:
    return [u["symbol"] for u in universe()]


def safe_name(symbol: str) -> str:
    """Nom de fichier sans caractères spéciaux (^GSPC, EURUSD=X, GC=F)."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in symbol)
