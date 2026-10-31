"""Contrôle croisé d'un ticker : prix et volatilité 1 an recalculés à la main.

1. Depuis les données en cache (history/<T>.json), en Python pur (module math, sans pandas),
   on recalcule la volatilité annualisée et on la compare à risk.json : écart attendu ~ 0.
2. Un second téléchargement yfinance indépendant (Ticker.history) donne le dernier prix
   et la volatilité, comparés au cache avec une petite tolérance (le marché a pu bouger).

python -m pipeline.crosscheck AAPL
"""
import math
import sys

from . import store
from .config import safe_name, settings


def manual_vol(closes: list[float], n: int, days: int) -> float:
    c = closes[-(n + 1):]
    r = [math.log(c[i] / c[i - 1]) for i in range(1, len(c))]
    m = sum(r) / len(r)
    var = sum((x - m) ** 2 for x in r) / (len(r) - 1)
    return math.sqrt(var) * math.sqrt(days)


def main(symbol: str = "AAPL") -> int:
    cfg = settings()["risk"]
    n, days = cfg["window_days"], cfg["trading_days_per_year"]
    hist = store.read(f"history/{safe_name(symbol)}")
    risk_doc = store.read("risk")
    quotes = store.read("quotes")
    if not hist or not risk_doc or not risk_doc.get("data"):
        print("cross-check: cached data missing, run `python -m pipeline daily` first")
        return 1
    rows = hist["data"]["rows"]
    adj = [r[5] for r in rows if r[5] is not None]
    cached_vol = risk_doc["data"]["metrics"][symbol]["ann_volatility"]
    vol_manual = manual_vol(adj, n, days)
    checks = [("1Y vol, manual (cache) vs risk.json", vol_manual, cached_vol, 1e-9)]

    import yfinance as yf
    fresh = yf.Ticker(symbol).history(period="2y", auto_adjust=False)
    fresh_adj = [float(x) for x in fresh["Adj Close"].dropna()]
    fresh_close = float(fresh["Close"].dropna().iloc[-1])
    cached_close = rows[-1][4]
    checks += [("last close, fresh yfinance vs cache", fresh_close, cached_close, 5e-3),
               ("1Y vol, manual (fresh yfinance) vs risk.json", manual_vol(fresh_adj, n, days), cached_vol, 1e-2)]
    if quotes and symbol in (quotes.get("data") or {}):
        checks.append(("quote price vs fresh last close", quotes["data"][symbol]["price"], fresh_close, 5e-3))

    ok = True
    print(f"Cross-check {symbol} (window {n} returns, x sqrt({days}))")
    for label, a, b, tol in checks:
        rel = abs(a - b) / abs(b) if b else abs(a - b)
        good = rel <= tol
        ok &= good
        print(f"  {'PASS' if good else 'FAIL'}  {label:48s} {a:.6f} vs {b:.6f}  (rel. diff {rel:.2e}, tol {tol:g})")
    store.write("crosscheck", {"symbol": symbol, "passed": ok,
                               "checks": [{"label": l, "a": a, "b": b, "tolerance": t} for l, a, b, t in checks]},
                "pipeline.crosscheck")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(*(sys.argv[1:2] or ["AAPL"])))
