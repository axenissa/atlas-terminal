"""Séries macro : CSV publics FRED (sans clé), avec des sources officielles de secours.

FRED renvoie parfois une page anti-robot en HTML au lieu du CSV. Dans ce cas chaque
série est reprise à sa source d'origine, elle aussi gratuite et sans clé :
  - rendements du Trésor (DGS*) : U.S. Treasury, daily par yield curve
  - Fed funds effectif (DFF)    : Federal Reserve Bank of New York (EFFR)
  - CPI et chômage              : Bureau of Labor Statistics (API publique v1)
La source réellement utilisée est indiquée pour chaque série.
"""
import io
from datetime import date

import pandas as pd
import requests

from . import store
from .config import settings

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
           "Accept": "text/csv,application/json;q=0.9,*/*;q=0.8"}

TREASURY_COLS = {"DGS1MO": "1 Mo", "DGS3MO": "3 Mo", "DGS6MO": "6 Mo", "DGS1": "1 Yr", "DGS2": "2 Yr",
                 "DGS5": "5 Yr", "DGS10": "10 Yr", "DGS30": "30 Yr"}
BLS_IDS = {"CPIAUCSL": "CUSR0000SA0", "UNRATE": "LNS14000000"}


class SourceError(Exception):
    pass


def looks_like_html(text: str) -> bool:
    head = text.lstrip()[:200].lower()
    return head.startswith("<!doctype") or head.startswith("<html") or "<head" in head


def parse_fred_csv(text: str, sid: str) -> pd.Series:
    if looks_like_html(text):
        raise SourceError("FRED returned an HTML page instead of CSV")
    df = pd.read_csv(io.StringIO(text))
    date_col = "observation_date" if "observation_date" in df else df.columns[0]
    col = sid if sid in df else df.columns[1]
    s = pd.to_numeric(df[col], errors="coerce")   # FRED code les valeurs manquantes par "."
    s.index = pd.to_datetime(df[date_col])
    return s.dropna().rename(sid)


def parse_treasury_csv(text: str, sid: str) -> pd.Series:
    if looks_like_html(text):
        raise SourceError("Treasury returned HTML")
    df = pd.read_csv(io.StringIO(text))
    col = TREASURY_COLS[sid]
    if col not in df:
        return pd.Series(dtype=float, name=sid)
    s = pd.to_numeric(df[col], errors="coerce")
    s.index = pd.to_datetime(df["Date"], format="%m/%d/%Y")
    return s.dropna().sort_index().rename(sid)


def parse_nyfed_effr(payload: dict) -> pd.Series:
    rows = payload.get("refRates", [])
    s = pd.Series({pd.Timestamp(r["effectiveDate"]): float(r["percentRate"]) for r in rows
                   if r.get("percentRate") is not None}, dtype=float)
    return s.sort_index().rename("DFF")


def parse_bls(payload: dict, sid: str) -> pd.Series:
    if payload.get("status") != "REQUEST_SUCCEEDED":
        raise SourceError(f"BLS: {payload.get('message')}")
    vals = {}
    for series in payload["Results"]["series"]:
        for d in series["data"]:
            if not d["period"].startswith("M") or d["period"] == "M13":
                continue
            v = pd.to_numeric(d["value"], errors="coerce")
            if pd.notna(v):
                vals[pd.Timestamp(int(d["year"]), int(d["period"][1:]), 1)] = float(v)
    return pd.Series(vals, dtype=float).sort_index().rename(sid)


# --- téléchargements ---------------------------------------------------------

def _get(url: str, **kw) -> requests.Response:
    r = requests.get(url, headers=HEADERS, timeout=45, **kw)
    r.raise_for_status()
    return r


def from_fred(sid: str) -> pd.Series:
    cfg = settings()["fred"]
    s = parse_fred_csv(_get(cfg["csv_url"].format(series=sid)).text, sid)
    return s[s.index >= cfg["start"]]


def from_treasury(sid: str, years: int = 6) -> pd.Series:
    parts = []
    for y in range(date.today().year - years + 1, date.today().year + 1):
        url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
               f"daily-treasury-rates.csv/{y}/all?type=daily_treasury_yield_curve"
               f"&field_tdr_date_value={y}&page&_format=csv")
        parts.append(parse_treasury_csv(_get(url).text, sid))
    return pd.concat(parts).sort_index()


def from_nyfed(sid: str) -> pd.Series:
    url = ("https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json"
           f"?startDate=2016-03-01&endDate={date.today().isoformat()}")
    return parse_nyfed_effr(_get(url).json())


def from_bls(sid: str) -> pd.Series:
    # API v1 sans clé : 10 ans maximum par requête
    end = date.today().year
    parts = []
    for start in (end - 19, end - 9):
        r = requests.post("https://api.bls.gov/publicAPI/v1/timeseries/data/", timeout=45,
                          json={"seriesid": [BLS_IDS[sid]], "startyear": str(start),
                                "endyear": str(min(start + 9, end))}, headers=HEADERS)
        r.raise_for_status()
        parts.append(parse_bls(r.json(), sid))
    return pd.concat(parts).sort_index()


FALLBACKS = {**{k: ("U.S. Treasury", from_treasury) for k in TREASURY_COLS},
             "DFF": ("Federal Reserve Bank of New York (EFFR)", from_nyfed),
             "CPIAUCSL": ("U.S. Bureau of Labor Statistics", from_bls),
             "UNRATE": ("U.S. Bureau of Labor Statistics", from_bls)}


def fetch(sid: str) -> tuple[pd.Series | None, str | None, str | None]:
    """Renvoie (série, source utilisée, erreur)."""
    errors = []
    try:
        return from_fred(sid), "FRED (St. Louis Fed)", None
    except Exception as e:
        errors.append(f"FRED: {type(e).__name__}: {e}")
    if sid in FALLBACKS:
        name, fn = FALLBACKS[sid]
        try:
            s = fn(sid)
            if not s.empty:
                return s, name, None
            errors.append(f"{name}: empty series")
        except Exception as e:
            errors.append(f"{name}: {type(e).__name__}: {e}")
    return None, None, "; ".join(errors)


# --- indicateurs dérivés ------------------------------------------------------

def yoy(s: pd.Series) -> pd.Series:
    """Variation sur 12 mois d'une série mensuelle."""
    m = s.resample("MS").last().dropna()
    return (m / m.shift(12) - 1).dropna() * 100


def last_point(s: pd.Series | None) -> dict | None:
    if s is None or s.dropna().empty:
        return None
    s = s.dropna()
    return {"date": s.index[-1].strftime("%Y-%m-%d"), "value": float(s.iloc[-1])}


def spread_2s10s(dgs10: pd.Series, dgs2: pd.Series) -> pd.Series:
    df = pd.concat([dgs10, dgs2], axis=1, join="inner").dropna()
    return (df.iloc[:, 0] - df.iloc[:, 1]).rename("2s10s")


def to_points(s: pd.Series, freq: str | None = None) -> list[list]:
    if freq:
        s = s.resample(freq).last().dropna()
    return [[d.strftime("%Y-%m-%d"), round(float(v), 4)] for d, v in s.dropna().items()]


def refresh() -> dict:
    cfg = settings()["fred"]
    series, sources, errors = {}, {}, {}
    for sid in cfg["series"]:
        s, src, err = fetch(sid)
        if s is not None:
            series[sid], sources[sid] = s, src
        if err:
            errors[sid] = err

    strip = {"fed_funds": last_point(series.get("DFF")), "ust_10y": last_point(series.get("DGS10")),
             "ust_2y": last_point(series.get("DGS2")), "spread_2s10s": None, "cpi_yoy": None,
             "unemployment": last_point(series.get("UNRATE"))}
    derived = {}
    if "DGS10" in series and "DGS2" in series:
        derived["2s10s"] = spread_2s10s(series["DGS10"], series["DGS2"])
        strip["spread_2s10s"] = last_point(derived["2s10s"])
    if "CPIAUCSL" in series:
        derived["CPI_YOY"] = yoy(series["CPIAUCSL"])
        strip["cpi_yoy"] = last_point(derived["CPI_YOY"])

    curve = []
    for sid in cfg["yield_curve"]:
        p = last_point(series.get(sid))
        if p:
            curve.append({"series": sid, "label": cfg["series"][sid].replace("Treasury ", ""), **p})

    rf = last_point(series.get(cfg["risk_free"]))
    payload = {
        "strip": strip,
        "yield_curve": curve,
        "risk_free": rf,
        "labels": cfg["series"],
        "series_source": sources,
        # séries quotidiennes ramenées en hebdomadaire pour garder la page légère
        "series": {sid: to_points(s, "W-FRI" if sid.startswith("DGS") or sid == "DFF" else None)
                   for sid, s in series.items()},
        "derived": {k: to_points(v, "W-FRI" if k == "2s10s" else None) for k, v in derived.items()},
    }
    store.write("macro", payload, "FRED public CSV (fallbacks: U.S. Treasury, NY Fed, BLS)", errors)
    return payload
