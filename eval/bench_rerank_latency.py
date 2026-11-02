"""Measure how long the reranker sidecar takes per request, for a given number of candidates.

Usage (stdlib only):

    docker run -d --rm -p 127.0.0.1:8001:8001 --name smoi-reranker-bench smoi-reranker:dev
    python eval/bench_rerank_latency.py --candidates 10 30 50 --runs 20

Each request sends one query and N passages of about 2,000 characters (the size of a default
500-token chunk). It also checks that a passage that answers the query outscores unrelated ones.
Results go to eval/results/rerank_latency_<timestamp>.json.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent

RELEVANT = ("The Larkspur Community Garden opens at 7:00 on weekdays and at 9:00 on Saturdays and Sundays. "
            "It closes at sunset all year. ")
FILLER = ("Quarterly estimated tax payments are due in April, June, September and January, and late payments "
          "may incur penalties and interest charged by the revenue agency. ")
QUERY = "What time does the garden open on Saturdays?"


def post(url: str, body: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def passages(n: int) -> list[str]:
    unrelated = (FILLER * 20)[:2000]
    relevant = (RELEVANT + FILLER * 20)[:2000]
    items = [unrelated] * n
    items[n // 2] = relevant  # the answer sits in the middle, not first
    return items


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--url", default="http://127.0.0.1:8001")
    p.add_argument("--candidates", type=int, nargs="+", default=[10, 30, 50])
    p.add_argument("--runs", type=int, default=20)
    args = p.parse_args()

    post(f"{args.url}/rerank", {"query": QUERY, "passages": passages(5)})  # warm-up
    rows = []
    for n in args.candidates:
        items = passages(n)
        times, correct = [], 0
        for _ in range(args.runs):
            start = time.perf_counter()
            scores = post(f"{args.url}/rerank", {"query": QUERY, "passages": items})["scores"]
            times.append((time.perf_counter() - start) * 1000)
            correct += scores.index(max(scores)) == n // 2
        times.sort()
        row = {"candidates": n, "runs": args.runs,
               "p50_ms": round(statistics.median(times), 1),
               "p95_ms": round(times[max(0, int(len(times) * 0.95) - 1)], 1),
               "relevant_ranked_first": f"{correct}/{args.runs}"}
        rows.append(row)
        print(row)

    out = ROOT / "results" / f"rerank_latency_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"script": "eval/bench_rerank_latency.py", "url": args.url,
                               "run_at": datetime.now().isoformat(timespec="seconds"),
                               "passage_chars": 2000, "results": rows}, indent=2), encoding="utf-8")
    print(f"Saved {out.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
