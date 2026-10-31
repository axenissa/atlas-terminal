"""Métriques de risque, définitions fixes (données quotidiennes, 252 derniers jours).

r_t            = ln(P_t / P_{t-1}) sur les clôtures ajustées
volatilité     = std(r) x sqrt(252)            (écart-type d'échantillon, ddof = 1)
rendement      = moyenne(r) x 252
Sharpe         = (rendement - rf) / volatilité, rf = dernier DGS3MO / 100
bêta           = cov(r_titre, r_indice) / var(r_indice), sur les dates communes
perte maximale = plus forte baisse d'un plus haut au plus bas suivant, sur la période
corrélation    = matrice des corrélations des rendements quotidiens (dates communes)
"""
import numpy as np
import pandas as pd

from .config import settings


def _params():
    r = settings()["risk"]
    return r["window_days"], r["trading_days_per_year"]


def log_returns(prices: pd.Series) -> pd.Series:
    p = prices.dropna().astype(float)
    return np.log(p / p.shift(1)).dropna()


def window(prices: pd.Series, n: int | None = None) -> pd.Series:
    """Les n derniers rendements demandent n + 1 prix."""
    n = n or _params()[0]
    return prices.dropna().iloc[-(n + 1):]


def annualized_volatility(r: pd.Series, days_per_year: int | None = None) -> float:
    days_per_year = days_per_year or _params()[1]
    return float(r.std(ddof=1) * np.sqrt(days_per_year))


def annualized_return(r: pd.Series, days_per_year: int | None = None) -> float:
    days_per_year = days_per_year or _params()[1]
    return float(r.mean() * days_per_year)


def sharpe_ratio(ann_return: float, ann_vol: float, risk_free: float) -> float | None:
    if not ann_vol:
        return None
    return float((ann_return - risk_free) / ann_vol)


def beta(r_asset: pd.Series, r_bench: pd.Series) -> float | None:
    df = pd.concat([r_asset.rename("a"), r_bench.rename("b")], axis=1, join="inner").dropna()
    if len(df) < 2 or df["b"].var(ddof=1) == 0:
        return None
    return float(df["a"].cov(df["b"], ddof=1) / df["b"].var(ddof=1))


def max_drawdown(prices: pd.Series) -> float:
    """Valeur négative : -0.25 = baisse de 25 % entre un sommet et le creux suivant."""
    p = prices.dropna().astype(float)
    return float((p / p.cummax() - 1).min())


def aligned_prices(prices: dict[str, pd.Series]) -> pd.DataFrame:
    """Prix sur les seules dates où tous les actifs cotent (crypto le week-end, jours fériés)."""
    return pd.concat(prices, axis=1, join="inner").dropna()


def correlation_matrix(prices: dict[str, pd.Series], n: int | None = None) -> pd.DataFrame:
    n = n or _params()[0]
    df = aligned_prices(prices)
    r = np.log(df / df.shift(1)).dropna().iloc[-n:]
    return r.corr()


def metrics(prices: pd.Series, bench: pd.Series | None, risk_free: float) -> dict:
    n, _ = _params()
    p = window(prices, n)
    r = log_returns(p)
    vol = annualized_volatility(r)
    ret = annualized_return(r)
    out = {
        "observations": int(len(r)),
        "start": p.index[0].strftime("%Y-%m-%d"),
        "end": p.index[-1].strftime("%Y-%m-%d"),
        "ann_volatility": vol,
        "ann_return": ret,
        "sharpe": sharpe_ratio(ret, vol, risk_free),
        "max_drawdown": max_drawdown(p),
        "beta": None,
    }
    if bench is not None and not bench.empty:
        # bêta sur les dates communes, puis les 252 derniers rendements
        df = aligned_prices({"a": prices, "b": bench})
        ra, rb = log_returns(df["a"]).iloc[-n:], log_returns(df["b"]).iloc[-n:]
        out["beta"] = beta(ra, rb)
    return out


def compute_all(closes: dict[str, pd.Series], benchmark: str, risk_free: float) -> dict:
    bench = closes.get(benchmark)
    per = {}
    for sym, s in closes.items():
        if s is None or len(s.dropna()) < 30:
            per[sym] = {"error": "not enough price history"}
            continue
        per[sym] = metrics(s, bench, risk_free)
    usable = {k: v for k, v in closes.items() if v is not None and len(v.dropna()) >= 30}
    corr = correlation_matrix(usable) if len(usable) >= 2 else pd.DataFrame()
    return {
        "risk_free": risk_free,
        "benchmark": benchmark,
        "metrics": per,
        "correlation": {"symbols": list(corr.columns), "matrix": corr.round(4).values.tolist()},
    }
