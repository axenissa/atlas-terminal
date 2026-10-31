"""Lecture des formats renvoyés par chaque source (fichiers d'exemple au format réel)."""
import json

import numpy as np
import pandas as pd
import pytest

from pipeline import cbm, macro, market, news, sec, sentiment, store

FRED_CSV = "observation_date,DGS10\n2024-01-02,3.95\n2024-01-03,.\n2024-01-04,3.99\n"
FRED_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<script src=\"/x\"></script></head></html>"
TREASURY_CSV = ('Date,"1 Mo","2 Mo","3 Mo","6 Mo","1 Yr","2 Yr","5 Yr","10 Yr","30 Yr"\n'
                '01/03/2024,5.54,5.52,5.47,5.30,4.85,4.33,3.93,3.91,4.05\n'
                '01/02/2024,5.55,5.54,5.46,5.24,4.80,4.33,3.93,3.95,4.08\n')
GOOGLE_RSS = """<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<item><title>Apple shares rise after earnings - Reuters</title><link>https://news.google.com/a1</link>
<pubDate>Tue, 29 Oct 2024 20:15:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
<item><title>Older Apple story - CNBC</title><link>https://news.google.com/a2</link>
<pubDate>Mon, 28 Oct 2024 10:00:00 GMT</pubDate><source url="https://cnbc.com">CNBC</source></item>
</channel></rss>"""


def test_fred_csv_skips_missing_values():
    s = macro.parse_fred_csv(FRED_CSV, "DGS10")
    assert list(s.values) == [3.95, 3.99]


def test_fred_html_page_is_rejected():
    with pytest.raises(macro.SourceError):
        macro.parse_fred_csv(FRED_HTML, "DGS10")


def test_treasury_csv():
    s = macro.parse_treasury_csv(TREASURY_CSV, "DGS10")
    assert s.index[0] == pd.Timestamp("2024-01-02") and s.iloc[-1] == 3.91


def test_nyfed_and_bls():
    e = macro.parse_nyfed_effr({"refRates": [{"effectiveDate": "2024-10-01", "percentRate": 4.83},
                                             {"effectiveDate": "2024-09-30", "percentRate": 4.83}]})
    assert e.index[-1] == pd.Timestamp("2024-10-01")
    b = macro.parse_bls({"status": "REQUEST_SUCCEEDED", "Results": {"series": [{"data": [
        {"year": "2024", "period": "M09", "value": "314.851"},
        {"year": "2024", "period": "M13", "value": "999"},
        {"year": "2024", "period": "M08", "value": "314.121"}]}]}}, "CPIAUCSL")
    assert list(b.values) == [314.121, 314.851]


def test_cpi_yoy_and_spread():
    idx = pd.date_range("2023-01-01", periods=13, freq="MS")
    cpi = pd.Series(np.linspace(100, 103, 13), index=idx)
    assert macro.yoy(cpi).iloc[-1] == pytest.approx(3.0)
    d = pd.bdate_range("2024-01-01", periods=3)
    sp = macro.spread_2s10s(pd.Series([4.0, 4.1, 4.2], d), pd.Series([4.5, 4.4, 4.3], d))
    assert list(sp.round(2)) == [-0.5, -0.3, -0.1]


def test_google_rss_strips_publisher_suffix():
    items = news.parse_google_rss(GOOGLE_RSS)
    assert items[0]["title"] == "Apple shares rise after earnings"
    assert items[0]["publisher"] == "Reuters" and items[0]["feed"] == "Google News"
    assert items[0]["published"].startswith("2024-10-29T20:15")


def test_yahoo_news_both_formats():
    new = [{"id": "x", "content": {"title": "T1", "pubDate": "2024-10-29T12:00:00Z",
                                   "provider": {"displayName": "Bloomberg"},
                                   "canonicalUrl": {"url": "https://finance.yahoo.com/t1"}}}]
    old = [{"title": "T2", "publisher": "Reuters", "link": "https://x/t2", "providerPublishTime": 1730203200}]
    a, b = news.parse_yahoo(new)[0], news.parse_yahoo(old)[0]
    assert (a["publisher"], a["feed"]) == ("Bloomberg", "Yahoo")
    assert b["published"].startswith("2024-10-29")


def test_latest_dedupes_and_sorts():
    items = [{"title": "A", "published": "2024-01-01"}, {"title": "a", "published": "2024-01-02"},
             {"title": "B", "published": "2024-01-03"}]
    out = news.latest(items, 10)
    assert [i["title"] for i in out] == ["B", "A"]


def test_sentiment_with_stub_classifier():
    def stub(titles, batch_size):
        return [[{"label": "positive", "score": 0.8}, {"label": "neutral", "score": 0.15},
                 {"label": "negative", "score": 0.05}],
                [{"label": "positive", "score": 0.1}, {"label": "neutral", "score": 0.2},
                 {"label": "negative", "score": 0.7}]][: len(titles)]
    s = sentiment.score_titles(["good", "bad"], classifier=stub)
    assert s[0]["label"] == "positive" and s[0]["confidence"] == 0.8
    assert s[1]["net"] == pytest.approx(-0.6)
    avg = sentiment.average(s)
    assert avg["net"] == pytest.approx(0.075) and avg["label"] == "neutral"


def test_sec_ticker_table():
    t = sec.parse({"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}})
    assert t["AAPL"] == [320193, "Apple Inc."]


def test_cbm_divergence_history():
    latest = {"banks": {"FED": {"currency": "USD"}, "ECB": {"currency": "EUR"}, "BOJ": {"currency": "JPY"}},
              "divergence": {"EURUSD": 0, "USDJPY": 0}}
    hist = pd.DataFrame({"FED": [10.0, 20.0], "ECB": [30.0, 0.0], "BOJ": [-10.0, 40.0]},
                        index=pd.to_datetime(["2024-01-05", "2024-01-12"]))
    d = cbm.divergence_history(hist, latest)
    assert list(d["EURUSD"]) == [10.0, -10.0]
    assert list(d["USDJPY"]) == [10.0, -10.0]


def test_store_replaces_nan(tmp_path):
    store.write("x", {"a": float("nan"), "b": [1.0, float("inf")], "c": np.float64(2.5)}, "test", base=tmp_path)
    doc = json.loads((tmp_path / "x.json").read_text())
    assert doc["data"] == {"a": None, "b": [1.0, None], "c": 2.5} and doc["source"] == "test"


def test_quote_from_daily_only():
    d = pd.DataFrame({"Close": [10.0, 11.0], "High": [10.5, 11.5], "Low": [9.5, 10.5]},
                     index=pd.to_datetime(["2024-01-02", "2024-01-03"]))
    q = market.quote_from(d, None)
    assert q["price"] == 11.0 and q["change"] == pytest.approx(1.0) and q["pct_change"] == pytest.approx(0.1)


def test_quote_from_intraday_uses_previous_session_close():
    d = pd.DataFrame({"Close": [10.0, 11.0, 11.5], "High": [11, 12, 12.0], "Low": [9, 10, 11.0]},
                     index=pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04"]))
    ts = pd.date_range("2024-01-04 09:30", periods=3, freq="5min", tz="America/New_York")
    i = pd.DataFrame({"Close": [11.2, 11.3, 11.6]}, index=ts)
    q = market.quote_from(d, i)
    assert q["price"] == 11.6 and q["prev_close"] == 11.0
