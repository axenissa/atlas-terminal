"""Lecture des sorties de CB-Monitor (score hawkish/dovish G10 et backtest de divergence)."""
import io
import json
import os
from pathlib import Path

import pandas as pd
import requests

from . import store
from .config import ROOT, settings


def _reader():
    cfg = settings()["cbmonitor"]
    if cfg.get("repo"):
        base = f"https://raw.githubusercontent.com/{cfg['repo']}/{cfg['branch']}/"

        # dépôt privé : jeton GitHub en lecture seule dans le secret CBM_TOKEN
        token = os.environ.get("CBM_TOKEN")
        headers = {"Authorization": f"token {token}"} if token else {}

        def read(rel):
            r = requests.get(base + rel, timeout=30, headers=headers)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.text
        return read, f"GitHub {cfg['repo']}@{cfg['branch']}"

    local = (ROOT / cfg["local_path"]).resolve()

    def read(rel):
        p = Path(local) / rel
        return p.read_text(encoding="utf-8") if p.exists() else None
    return read, "local folder"


def divergence_history(history: pd.DataFrame, latest: dict) -> pd.DataFrame:
    """Divergence par paire = (score banque de la devise de base - score banque de la devise de cotation) / 2."""
    by_ccy = {b["currency"]: code for code, b in latest["banks"].items()}
    out = {}
    for pair in latest.get("divergence", {}):
        base, quote = by_ccy.get(pair[:3]), by_ccy.get(pair[3:])
        if base in history and quote in history:
            out[pair] = (history[base] - history[quote]) / 2
    return pd.DataFrame(out)


def frame_points(df: pd.DataFrame) -> dict:
    return {"dates": [d.strftime("%Y-%m-%d") for d in df.index],
            "series": {c: [None if pd.isna(v) else round(float(v), 2) for v in df[c]] for c in df.columns}}


def refresh() -> dict | None:
    cfg = settings()["cbmonitor"]
    read, origin = _reader()
    errors = {}
    try:
        raw_latest = read(cfg["files"]["latest"])
    except Exception as e:
        raw_latest, errors["latest"] = None, f"{type(e).__name__}: {e}"
    if not raw_latest:
        errors.setdefault("latest", "composite_latest.json not found")
        store.write("cbm", None, f"CB-Monitor ({origin})", errors)
        return None

    latest = json.loads(raw_latest)
    payload = {"latest": latest, "history": None, "divergence_history": None, "backtest": None}
    freq = cfg["history_resample"]
    try:
        raw_hist = read(cfg["files"]["history"])
        if raw_hist:
            hist = pd.read_csv(io.StringIO(raw_hist), index_col="date", parse_dates=True).sort_index()
            weekly = hist.resample(freq).last()
            payload["history"] = frame_points(weekly)
            payload["divergence_history"] = frame_points(divergence_history(weekly, latest))
    except Exception as e:
        errors["history"] = f"{type(e).__name__}: {e}"

    try:
        raw_sum = read(cfg["files"]["backtest_summary"])
        raw_eq = read(cfg["files"]["backtest_equity"])
        if raw_sum:
            eq = None
            if raw_eq:
                e = pd.read_csv(io.StringIO(raw_eq), index_col="date", parse_dates=True).sort_index()
                eq = frame_points(e.resample(freq).last().dropna(how="all"))
            payload["backtest"] = {"summary": json.loads(raw_sum), "equity": eq}
        else:
            errors["backtest"] = "backtest not published yet (run: python -m cbmonitor backtest)"
    except Exception as e:
        errors["backtest"] = f"{type(e).__name__}: {e}"

    store.write("cbm", payload, f"CB-Monitor ({origin})", errors)
    return payload
