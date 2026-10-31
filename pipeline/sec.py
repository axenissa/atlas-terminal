"""Table ticker -> CIK de la SEC (sert à l'onglet FA pour n'importe quelle action américaine)."""
import requests

from . import store
from .config import settings


def parse(payload: dict) -> dict:
    return {row["ticker"].upper(): [int(row["cik_str"]), row["title"]] for row in payload.values()}


def refresh() -> dict | None:
    cfg = settings()["sec"]
    try:
        r = requests.get(cfg["tickers_url"], headers={"User-Agent": cfg["user_agent"]}, timeout=30)
        r.raise_for_status()
        table = parse(r.json())
    except Exception as e:
        store.write("sec_cik", None, "SEC EDGAR company_tickers.json", {"_all": f"{type(e).__name__}: {e}"})
        return None
    store.write("sec_cik", table, "SEC EDGAR company_tickers.json")
    return table
