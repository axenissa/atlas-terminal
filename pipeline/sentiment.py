"""Sentiment des titres avec FinBERT (ProsusAI/finbert), exécuté sur CPU, sans jeton.

Pour chaque titre : étiquette la plus probable (positive / neutral / negative) et sa
probabilité (confiance). Score moyen d'un ticker = moyenne de P(positive) - P(negative),
entre -1 et +1, ce qui tient compte de la confiance de chaque lecture.
"""
from functools import lru_cache

from .config import settings


@lru_cache(maxsize=1)
def _classifier():
    from transformers import pipeline  # import tardif : transformers et torch sont lourds

    return pipeline("text-classification", model=settings()["sentiment"]["model"], top_k=None,
                    truncation=True, device=-1)


def score_titles(titles: list[str], classifier=None) -> list[dict]:
    if not titles:
        return []
    clf = classifier or _classifier()
    raw = clf(titles, batch_size=settings()["sentiment"]["batch_size"])
    out = []
    for dist in raw:
        probs = {d["label"].lower(): float(d["score"]) for d in dist}
        label = max(probs, key=probs.get)
        out.append({"label": label, "confidence": probs[label],
                    "net": probs.get("positive", 0.0) - probs.get("negative", 0.0)})
    return out


def average(scored: list[dict]) -> dict | None:
    if not scored:
        return None
    net = sum(s["net"] for s in scored) / len(scored)
    counts = {k: sum(1 for s in scored if s["label"] == k) for k in ("positive", "neutral", "negative")}
    band = settings()["sentiment"]["neutral_band"]
    label = "positive" if net > band else "negative" if net < -band else "neutral"
    return {"net": net, "label": label, "counts": counts, "n": len(scored)}
