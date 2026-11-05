"""File-level retrieval eval for the brain upgrade (eval/data/brain_v1.csv).

Each row is a query, the file it should find (blank for queries that should find nothing) and an
optional page. A query counts as a hit at rank r when the r-th distinct file in the search results
is the expected file (and, if a page is given, one of that file's returned chunks covers the page).

Categories: exact (distinctive terms), paraphrase (same meaning, other words), filename (asks for a
file by name, including typos and spaces), no_result (nothing in the corpus matches).

Metrics per category and overall (answerable rows only): recall@5, MRR@10. For no_result rows:
the share where search returned no results ("correctly empty"). Latency: wall-clock and server
total per query.
"""

import csv
import time
from dataclasses import dataclass
from pathlib import Path

from . import metrics
from .api import SmoiClient
from .corpus import manifest

BRAIN_SET = Path(__file__).resolve().parent.parent / "data" / "brain_v1.csv"
CATEGORIES = ("exact", "paraphrase", "filename", "no_result")
COLUMNS = ["id", "category", "query", "expected_file", "expected_page", "notes"]


@dataclass(frozen=True)
class BrainQuery:
    id: str
    category: str
    query: str
    expected_file: str | None
    expected_page: int | None


def load(path: Path = BRAIN_SET) -> list[BrainQuery]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    return [BrainQuery(r["id"].strip(), r["category"].strip(), r["query"].strip(),
                       r["expected_file"].strip() or None,
                       int(r["expected_page"]) if r["expected_page"].strip() else None) for r in rows]


def validate(queries: list[BrainQuery], known_files: set[str] | None = None) -> list[str]:
    known = known_files if known_files is not None else {d["file"] for d in manifest()}
    problems, seen = [], set()
    for q in queries:
        if q.id in seen:
            problems.append(f"{q.id}: duplicate id")
        seen.add(q.id)
        if q.category not in CATEGORIES:
            problems.append(f"{q.id}: unknown category {q.category!r}")
        if not q.query:
            problems.append(f"{q.id}: empty query")
        if q.category == "no_result":
            if q.expected_file:
                problems.append(f"{q.id}: no_result rows must leave expected_file empty")
        elif not q.expected_file:
            problems.append(f"{q.id}: expected_file is required")
        elif q.expected_file not in known:
            problems.append(f"{q.id}: {q.expected_file} is not in the corpus")
        if q.expected_page is not None and q.expected_page < 1:
            problems.append(f"{q.id}: expected_page must be 1 or more")
    return problems


def file_rank(results: list[dict], expected_file: str, expected_page: int | None = None) -> int | None:
    """1-based rank of the expected file among the distinct files in result order, or None."""
    files: list[str] = []
    for r in results:
        if r["filename"] not in files:
            files.append(r["filename"])
    if expected_file not in files:
        return None
    if expected_page is not None:
        on_page = any(r["filename"] == expected_file and r.get("pageStart") is not None
                      and r["pageStart"] <= expected_page <= (r.get("pageEnd") or r["pageStart"]) for r in results)
        if not on_page:
            return None
    return files.index(expected_file) + 1


def run(client: SmoiClient, queries: list[BrainQuery], modes: list[str], top_k: int = 10, log=print) -> dict:
    records: dict[str, list[dict]] = {}
    for mode in modes:
        client.retry_rate_limited(lambda: client.search("warm-up query about frogs and databases", mode, top_k))  # load models before timing
        rows = []
        for q in queries:
            def timed_search():
                started = time.perf_counter()
                body = client.search(q.query, mode, top_k)
                return body, (time.perf_counter() - started) * 1000

            body, wall_ms = client.retry_rate_limited(timed_search)
            results = body["results"]
            row = {"id": q.id, "category": q.category, "mode": mode, "rerank": body.get("rerank"),
                   "wall_ms": round(wall_ms, 1), "server_ms": body["timings"]["totalMs"],
                   "returned": len(results), "top_score": results[0]["score"] if results else None,
                   "top_files": list(dict.fromkeys(r["filename"] for r in results))[:5]}
            if q.expected_file:
                rank = file_rank(results, q.expected_file, q.expected_page)
                row.update({"rank": rank, "recall@5": 1.0 if rank and rank <= 5 else 0.0,
                            "mrr@10": 1.0 / rank if rank and rank <= 10 else 0.0})
            else:
                row["correctly_empty"] = 1.0 if not results else 0.0
            rows.append(row)
        records[mode] = rows
        log(f"  {mode}: {len(rows)} queries")
    return records


def summarize(records: dict[str, list[dict]]) -> dict:
    summary = {}
    for mode, rows in records.items():
        scored = [r for r in rows if "rank" in r]
        empty = [r for r in rows if "correctly_empty" in r]
        summary[mode] = {
            "overall": _scores(scored),
            "by_category": {c: _scores([r for r in scored if r["category"] == c])
                            for c in CATEGORIES if c != "no_result"},
            "no_result": {"queries": len(empty),
                          "correctly_empty": metrics.mean([r["correctly_empty"] for r in empty]) if empty else None},
            "latency_ms": {"wall_mean": metrics.mean([r["wall_ms"] for r in rows]),
                           "wall_p50": metrics.percentile([r["wall_ms"] for r in rows], 50),
                           "wall_p95": metrics.percentile([r["wall_ms"] for r in rows], 95),
                           "server_mean": metrics.mean([r["server_ms"] for r in rows]),
                           "queries": len(rows)},
            "rerank_applied": sum(r["rerank"] == "applied" for r in rows) if mode == "hybrid_rerank" else None,
        }
    return summary


def _scores(rows: list[dict]) -> dict:
    if not rows:
        return {"queries": 0}
    return {"queries": len(rows), "recall@5": metrics.mean([r["recall@5"] for r in rows]),
            "mrr@10": metrics.mean([r["mrr@10"] for r in rows])}


def misses(records: dict[str, list[dict]]) -> dict[str, list[str]]:
    return {mode: [r["id"] for r in rows if r.get("recall@5") == 0.0 or r.get("correctly_empty") == 0.0]
            for mode, rows in records.items()}
