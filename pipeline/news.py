"""Titres d'actualité : yfinance Ticker.news d'abord, flux RSS Google News en secours."""
import calendar
from datetime import datetime, timezone
from urllib.parse import quote_plus

import feedparser
import requests
import yfinance as yf

from .config import settings


def _iso(ts) -> str | None:
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, tz=timezone.utc).replace(microsecond=0).isoformat()
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except ValueError:
        return None


def parse_yahoo(items: list) -> list[dict]:
    """Deux formats existent selon la version de yfinance (à plat, ou sous la clé 'content')."""
    out = []
    for it in items or []:
        c = it.get("content", it)
        title = c.get("title")
        link = ((c.get("canonicalUrl") or {}).get("url") or (c.get("clickThroughUrl") or {}).get("url")
                or c.get("link"))
        publisher = (c.get("provider") or {}).get("displayName") or c.get("publisher")
        date = _iso(c.get("pubDate") or c.get("displayTime") or c.get("providerPublishTime"))
        if title and link:
            out.append({"title": title.strip(), "publisher": publisher, "published": date,
                        "link": link, "feed": "Yahoo"})
    return out


def parse_google_rss(text: str) -> list[dict]:
    feed = feedparser.parse(text)
    out = []
    for e in feed.entries:
        title = e.get("title", "").strip()
        publisher = (e.get("source") or {}).get("title")
        # Google ajoute " - Éditeur" à la fin du titre
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3].strip()
        date = None
        if e.get("published_parsed"):
            date = datetime.fromtimestamp(calendar.timegm(e.published_parsed), tz=timezone.utc).isoformat()
        if title and e.get("link"):
            out.append({"title": title, "publisher": publisher, "published": date,
                        "link": e["link"], "feed": "Google News"})
    return out


def latest(items: list[dict], n: int) -> list[dict]:
    seen, uniq = set(), []
    for it in items:
        key = it["title"].lower()
        if key not in seen:
            seen.add(key)
            uniq.append(it)
    uniq.sort(key=lambda x: x["published"] or "", reverse=True)
    return uniq[:n]


def fetch(symbol: str, query: str | None = None) -> tuple[list[dict], str | None]:
    """Renvoie (titres, erreur). Jamais de titre inventé : liste vide si les deux flux échouent."""
    cfg = settings()["news"]
    n, errors = cfg["per_ticker"], []
    items = []
    try:
        items = parse_yahoo(yf.Ticker(symbol).news)
    except Exception as e:
        errors.append(f"Yahoo: {type(e).__name__}: {e}")
    if len(items) < n:
        q = query or cfg["default_query"].format(symbol=symbol)
        url = cfg["google_rss"].format(query=quote_plus(q))
        try:
            r = requests.get(url, timeout=cfg["timeout_seconds"], headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            items += parse_google_rss(r.text)
        except Exception as e:
            errors.append(f"Google News: {type(e).__name__}: {e}")
    items = latest(items, n)
    return items, ("; ".join(errors) if errors and not items else None)
