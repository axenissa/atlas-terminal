"""Prix Yahoo Finance via yfinance (cotations différées)."""
import time

import pandas as pd
import yfinance as yf

from . import store
from .config import safe_name, settings

SOURCE = "Yahoo Finance via yfinance (delayed)"


def _split(df: pd.DataFrame, symbols: list[str]) -> dict[str, pd.DataFrame]:
    """yf.download(group_by='ticker') renvoie des colonnes (ticker, champ)."""
    out = {}
    for s in symbols:
        if isinstance(df.columns, pd.MultiIndex):
            if s not in df.columns.get_level_values(0):
                continue
            sub = df[s]
        else:
            sub = df
        sub = sub.dropna(how="all")
        if not sub.empty:
            out[s] = sub
    return out


def download_daily(symbols: list[str], period: str) -> dict[str, pd.DataFrame]:
    df = yf.download(symbols, period=period, interval="1d", auto_adjust=False, group_by="ticker",
                     progress=False, threads=True)
    return _split(df, symbols)


def download_intraday(symbols: list[str]) -> dict[str, pd.DataFrame]:
    df = yf.download(symbols, period="5d", interval="5m", auto_adjust=False, group_by="ticker",
                     progress=False, threads=True, prepost=False)
    return _split(df, symbols)


def history_rows(df: pd.DataFrame) -> list[list]:
    rows = []
    for ts, r in df.iterrows():
        rows.append([ts.strftime("%Y-%m-%d"), r.get("Open"), r.get("High"), r.get("Low"), r.get("Close"),
                     r.get("Adj Close"), None if pd.isna(r.get("Volume")) else int(r.get("Volume"))])
    return rows


def quote_from(daily: pd.DataFrame, intraday: pd.DataFrame | None) -> dict:
    """Dernier prix (barre 5 min la plus récente si dispo) et variation contre la clôture précédente."""
    closes = daily["Close"].dropna()
    last_day = closes.index[-1]
    if intraday is not None and not intraday["Close"].dropna().empty:
        ic = intraday["Close"].dropna()
        last, last_ts = float(ic.iloc[-1]), ic.index[-1]
        # clôture de référence : dernière clôture quotidienne strictement avant la séance en cours
        session_day = pd.Timestamp(last_ts).tz_localize(None).normalize() if last_ts.tzinfo else last_ts.normalize()
        prev = closes[closes.index < session_day]
        prev_close = float(prev.iloc[-1]) if len(prev) else None
        as_of = pd.Timestamp(last_ts).isoformat()
    else:
        last = float(closes.iloc[-1])
        prev_close = float(closes.iloc[-2]) if len(closes) > 1 else None
        as_of = last_day.strftime("%Y-%m-%d")
    change = None if prev_close is None else last - prev_close
    pct = None if not prev_close else change / prev_close
    return {"price": last, "prev_close": prev_close, "change": change, "pct_change": pct, "as_of": as_of,
            "high_52w": float(daily["High"].dropna().iloc[-252:].max()),
            "low_52w": float(daily["Low"].dropna().iloc[-252:].min())}


def all_symbols() -> list[str]:
    s = settings()
    seen, out = set(), []
    for sym in [u["symbol"] for u in s["universe"]] + s["market_board"] + [s["benchmark"]]:
        if sym not in seen:
            seen.add(sym)
            out.append(sym)
    return out


def refresh(write_history: bool = True) -> dict[str, pd.Series]:
    """Met à jour quotes.json (et history/*.json). Renvoie les clôtures ajustées pour le risque."""
    cfg = settings()["prices"]
    symbols = all_symbols()
    errors = {}
    try:
        daily = download_daily(symbols, cfg["history_period"])
    except Exception as e:
        store.write("quotes", {}, SOURCE, {"_all": f"{type(e).__name__}: {e}"})
        return {}
    time.sleep(cfg["batch_pause_seconds"])
    try:
        intraday = download_intraday(symbols)
    except Exception as e:
        intraday, errors["_intraday"] = {}, f"{type(e).__name__}: {e}"

    quotes, adj = {}, {}
    for sym in symbols:
        if sym not in daily:
            errors[sym] = "no data returned by Yahoo Finance"
            continue
        d = daily[sym]
        try:
            quotes[sym] = quote_from(d, intraday.get(sym))
        except Exception as e:
            errors[sym] = f"{type(e).__name__}: {e}"
            continue
        adj[sym] = d["Adj Close"].dropna()
        if write_history:
            store.write(f"history/{safe_name(sym)}", {"symbol": sym, "columns":
                        ["date", "open", "high", "low", "close", "adj_close", "volume"],
                        "rows": history_rows(d)}, SOURCE)
    store.write("quotes", quotes, SOURCE, errors)
    return adj
