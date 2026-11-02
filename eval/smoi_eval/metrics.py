"""Retrieval and answer metrics. Pure functions, unit-tested in eval/tests/test_metrics.py.

Relevance is decided by evidence quotes, not chunk ids: a chunk is relevant to an evidence item if it
contains the quoted sentence. Chunk ids change every time documents are re-chunked, but the quote
stays the same, so one set of labels works for every chunk size.
"""

import math
import re
import unicodedata

MIN_HALF_WORDS = 6


def normalize(text: str) -> str:
    """Lower-case ASCII words separated by single spaces. Folds accents, dashes, quotes and the
    character substitutions made for the PDF font, so a quote matches however it was rendered."""
    # Decompose "é" into "e" plus a combining accent and drop the accent; every other non-ASCII
    # character (dashes, symbols, Greek letters) then separates words rather than joining them.
    text = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def covers(chunk_text: str, quote: str) -> bool:
    """True if the chunk contains the quote. A quote cut in two by a chunk boundary counts for each
    chunk that holds at least half of it (and at least six words), so a boundary doesn't make the
    evidence unfindable."""
    chunk, q = f" {normalize(chunk_text)} ", normalize(quote)
    if f" {q} " in chunk:
        return True
    words = q.split()
    half = max(MIN_HALF_WORDS, (len(words) + 1) // 2)
    if len(words) < 2 * MIN_HALF_WORDS:
        return False
    head, tail = " ".join(words[:half]), " ".join(words[-half:])
    return f" {head} " in chunk or f" {tail} " in chunk


def evidence_hits(ranked_texts: list[str], quotes: list[str]) -> list[list[int]]:
    """For each quote, the 1-based ranks of the chunks that cover it."""
    return [[rank for rank, text in enumerate(ranked_texts, start=1) if covers(text, q)] for q in quotes]


def recall_at_k(hits: list[list[int]], k: int) -> float:
    """Share of evidence items with at least one covering chunk in the top k."""
    if not hits:
        raise ValueError("recall needs at least one evidence item")
    return sum(1 for ranks in hits if any(r <= k for r in ranks)) / len(hits)


def reciprocal_rank(hits: list[list[int]], k: int = 10) -> float:
    """1 / rank of the first chunk that covers any evidence item, or 0 if none is in the top k."""
    first = min((r for ranks in hits for r in ranks if r <= k), default=None)
    return 1.0 / first if first else 0.0


def ndcg_at_k(hits: list[list[int]], k: int = 10) -> float:
    """Normalised discounted cumulative gain with binary relevance at the evidence level.

    A chunk earns a gain of 1 at its rank if it covers an evidence item no higher-ranked chunk has
    covered yet; overlapping chunks that repeat the same evidence earn nothing. The ideal ranking
    puts one chunk per evidence item at the top.
    """
    covered: set[int] = set()
    dcg = 0.0
    for rank in range(1, k + 1):
        new = [i for i, ranks in enumerate(hits) if rank in ranks and i not in covered]
        if new:
            covered.add(new[0])
            dcg += 1 / math.log2(rank + 1)
    ideal = sum(1 / math.log2(rank + 1) for rank in range(1, min(len(hits), k) + 1))
    return dcg / ideal if ideal else 0.0


def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile: the smallest value with at least p% of values at or below it."""
    if not values:
        raise ValueError("percentile of an empty list")
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[rank - 1]


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else float("nan")


def cohen_kappa(a: list[str], b: list[str]) -> float:
    """Agreement between two raters beyond what chance would give: 1 is perfect, 0 is chance level."""
    if len(a) != len(b) or not a:
        raise ValueError("kappa needs two equally long, non-empty label lists")
    n = len(a)
    observed = sum(x == y for x, y in zip(a, b)) / n
    labels = set(a) | set(b)
    expected = sum((a.count(label) / n) * (b.count(label) / n) for label in labels)
    return 1.0 if expected == 1 else (observed - expected) / (1 - expected)


SENTENCE_END = re.compile(r"(?<=[.!?])(?:\s*\[S\d+(?:\s*,\s*S\d+)*\])*\s+(?=[A-Z\"'(\[])")


def split_sentences(answer: str) -> list[str]:
    """Splits an answer into sentences, keeping each sentence's trailing citations with it
    ("Frogs croak [S1]. They swim [S2]." gives two sentences, each with its label)."""
    parts, start = [], 0
    for m in SENTENCE_END.finditer(answer):
        parts.append(answer[start:m.end()].strip())
        start = m.end()
    parts.append(answer[start:].strip())
    return [p for p in parts if re.search(r"[A-Za-z]", p)]


LABEL = re.compile(r"\bS(\d+)\b")


def cited_labels(sentence: str) -> list[str]:
    labels = []
    for group in re.findall(r"\[([^\[\]]+)]", sentence):
        labels += [f"S{n}" for n in LABEL.findall(group)]
    return list(dict.fromkeys(labels))
