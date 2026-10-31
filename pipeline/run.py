"""Point d'entrée du job planifié.

python -m pipeline prices   prix + métriques de risque           (toutes les 15 min en séance)
python -m pipeline news     titres + sentiment FinBERT           (toutes les 30 min)
python -m pipeline daily    macro, SEC, CB-Monitor, prix, risque (une fois par jour)
python -m pipeline all      tout
"""
import argparse
import sys
import time

from . import cbm, macro, market, news, risk, sec, sentiment, store
from .config import settings, universe

SOURCE_RISK = "Computed from Yahoo Finance adjusted closes (yfinance) and FRED DGS3MO"


def write_config():
    s = settings()
    store.write("config", {k: s[k] for k in ("universe", "default_watchlist", "market_board", "benchmark",
                                             "strategies", "risk", "site", "sentiment")}
                | {"sec_user_agent_note": "SEC requests go through the Worker"}, "config/settings.yaml")


def risk_free_rate() -> tuple[float | None, str | None]:
    doc = store.read("macro")
    rf = (doc or {}).get("data", {}) or {}
    rf = rf.get("risk_free")
    if not rf:
        return None, "risk-free rate unavailable (macro.json has no DGS3MO)"
    return rf["value"] / 100, None


def run_prices():
    closes = market.refresh()
    if not closes:
        store.write("risk", None, SOURCE_RISK, {"_all": "no prices available"})
        return
    rf, err = risk_free_rate()
    if rf is None:
        store.write("risk", None, SOURCE_RISK, {"_all": err})
        return
    syms = [u["symbol"] for u in universe()]
    result = risk.compute_all({k: v for k, v in closes.items() if k in syms or k == settings()["benchmark"]},
                              settings()["benchmark"], rf)
    store.write("risk", result, SOURCE_RISK)


def run_news():
    cfg = settings()["sentiment"]
    out, errors = {}, {}
    for u in universe():
        items, err = news.fetch(u["symbol"], u.get("news_query"))
        if err:
            errors[u["symbol"]] = err
        out[u["symbol"]] = {"items": items, "average": None}
        time.sleep(0.5)
    if cfg["enabled"]:
        try:
            for sym, block in out.items():
                scored = sentiment.score_titles([it["title"] for it in block["items"]])
                for it, sc in zip(block["items"], scored):
                    it["sentiment"] = sc
                block["average"] = sentiment.average(scored)
        except Exception as e:
            errors["_sentiment"] = f"FinBERT unavailable: {type(e).__name__}: {e}"
    store.write("news", out, "yfinance Ticker.news, Google News RSS; sentiment ProsusAI/finbert", errors)


def run_daily():
    macro.refresh()
    sec.refresh()
    cbm.refresh()
    run_prices()


STEPS = {"prices": [run_prices], "news": [run_news], "daily": [run_daily], "all": [run_daily, run_news]}


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m pipeline")
    p.add_argument("mode", choices=list(STEPS))
    args = p.parse_args(argv)
    write_config()
    failed = []
    for step in STEPS[args.mode]:
        try:
            step()
        except Exception as e:  # une étape en échec ne doit pas bloquer les autres
            failed.append(f"{step.__name__}: {type(e).__name__}: {e}")
            print(f"[atlas] {failed[-1]}", file=sys.stderr)
    status = (store.read("status") or {}).get("data") or {}
    status[args.mode] = {"finished_at": store.now_iso(), "failed": failed}
    store.write("status", status, "pipeline")
    print(f"[atlas] {args.mode} done, {len(failed)} failed step(s)")


if __name__ == "__main__":
    main()
