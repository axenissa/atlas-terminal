"""Métriques de risque vérifiées sur un exemple calculé à la main.

Prix : 100 -> 110 -> 99 -> 108,9
  r1 = ln(110/100)  =  0.0953102
  r2 = ln(99/110)   = -0.1053605
  r3 = ln(108.9/99) =  0.0953102
  moyenne = 0.0852599 / 3 = 0.0284200            -> rendement annualisé = 0.02842 x 252 = 7.16183
  écarts à la moyenne : 0.0668902, -0.1337805, 0.0668902
  variance (n-1) = (0.0044743 + 0.0178972 + 0.0044743) / 2 = 0.0134229
  écart-type = 0.1158572                         -> volatilité annualisée = 0.1158572 x 15.874508 = 1.83917
  Sharpe (rf = 5 %) = (7.16183 - 0.05) / 1.83917 = 3.86687
  perte maximale : sommet 110, creux 99          -> -10 %
"""
import math

import numpy as np
import pandas as pd
import pytest

from pipeline import risk

DATES = pd.bdate_range("2024-01-01", periods=4)
P = pd.Series([100.0, 110.0, 99.0, 108.9], index=DATES)


def test_log_returns():
    r = risk.log_returns(P)
    assert list(r.round(7)) == [0.0953102, -0.1053605, 0.0953102]


def test_annualized_return():
    assert risk.annualized_return(risk.log_returns(P)) == pytest.approx(7.16183, abs=1e-4)


def test_annualized_volatility():
    assert risk.annualized_volatility(risk.log_returns(P)) == pytest.approx(1.83917, abs=1e-4)


def test_sharpe():
    assert risk.sharpe_ratio(7.16183, 1.83917, 0.05) == pytest.approx(3.86687, abs=1e-4)
    assert risk.sharpe_ratio(0.1, 0.0, 0.05) is None


def test_max_drawdown():
    assert risk.max_drawdown(P) == pytest.approx(-0.10, abs=1e-12)
    # deux baisses : 100 -> 80 (-20 %), puis 120 -> 90 (-25 %) : la plus forte compte
    p2 = pd.Series([100, 80, 120, 90, 130.0], index=pd.bdate_range("2024-01-01", periods=5))
    assert risk.max_drawdown(p2) == pytest.approx(-0.25)
    # série qui ne fait que monter
    assert risk.max_drawdown(pd.Series([1, 2, 3.0], index=pd.bdate_range("2024-01-01", periods=3))) == 0


def _from_returns(r, start=100.0):
    idx = pd.bdate_range("2024-01-01", periods=len(r) + 1)
    return pd.Series(start * np.exp(np.concatenate([[0], np.cumsum(r)])), index=idx)


def test_beta():
    # rendements de l'indice : +5 %, -5 %, +5 %, -3 % ; le titre fait exactement 2 fois l'indice
    b = np.array([0.05, -0.05, 0.05, -0.03])
    bench, asset = _from_returns(b), _from_returns(2 * b)
    assert risk.beta(risk.log_returns(asset), risk.log_returns(bench)) == pytest.approx(2.0)
    # à la main : moyenne(b) = 0.005, écarts 0.045 / -0.055 / 0.045 / -0.035
    # var(b) = 0.0083 / 3 = 0.0027667, cov(a, b) = 2 var(b) = 0.0055333 -> bêta = 2
    assert risk.log_returns(bench).var(ddof=1) == pytest.approx(0.0083 / 3, abs=1e-12)


def test_beta_uses_common_dates_only():
    b = _from_returns([0.01, -0.02, 0.015, 0.0, 0.01])
    a = b.drop(b.index[2]) * 3     # une date manquante côté titre
    m = risk.metrics(a, b, 0.0)
    assert m["beta"] is not None


def test_correlation_matrix():
    b = np.array([0.05, -0.05, 0.05, -0.03])
    prices = {"A": _from_returns(b), "B": _from_returns(2 * b), "C": _from_returns(-b)}
    c = risk.correlation_matrix(prices)
    assert c.loc["A", "B"] == pytest.approx(1.0)
    assert c.loc["A", "C"] == pytest.approx(-1.0)
    assert np.allclose(np.diag(c.values), 1.0)


def test_window_keeps_last_252_returns():
    p = _from_returns(np.full(400, 0.001))
    m = risk.metrics(p, None, 0.0)
    assert m["observations"] == 252
    assert m["ann_return"] == pytest.approx(0.001 * 252)
    assert m["ann_volatility"] == pytest.approx(0.0, abs=1e-12)


def test_metrics_end_to_end():
    m = risk.metrics(P, None, 0.05)
    assert m["ann_return"] == pytest.approx(7.16183, abs=1e-4)
    assert m["ann_volatility"] == pytest.approx(1.83917, abs=1e-4)
    assert m["sharpe"] == pytest.approx(3.86687, abs=1e-4)
    assert m["max_drawdown"] == pytest.approx(-0.10)
    assert math.isclose(math.sqrt(252), 15.874508, rel_tol=1e-7)


def test_crosscheck_manual_vol_matches_example():
    from pipeline.crosscheck import manual_vol
    assert manual_vol([100.0, 110.0, 99.0, 108.9], 252, 252) == pytest.approx(1.83917, abs=1e-4)
    assert manual_vol([100.0, 110.0, 99.0, 108.9], 252, 252) == pytest.approx(risk.annualized_volatility(risk.log_returns(P)))
