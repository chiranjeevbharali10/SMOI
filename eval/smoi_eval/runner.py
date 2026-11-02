"""The evaluation phases: retrieval for every mode, answers, and the faithfulness judge.

Each phase returns per-question records (saved in the results file so any failure can be inspected)
and aggregates computed from them.
"""

import random
import time

from . import metrics
from .api import ApiError, SmoiClient
from .corpus import IndexedCorpus
from .dataset import Evidence, Question

MODES = ["keyword", "vector", "hybrid", "hybrid_rerank"]
K_VALUES = (5, 10)


def evidence_hit_ranks(ranked_texts: list[str], evidence: tuple[Evidence, ...]) -> list[list[int]]:
    """Per evidence item, the ranks of chunks covering any of its alternative quotes."""
    hits = []
    for item in evidence:
        ranks = set()
        for quote in item.quotes():
            ranks.update(metrics.evidence_hits(ranked_texts, [quote])[0])
        hits.append(sorted(ranks))
    return hits


def check_evidence_indexed(questions: list[Question], corpus: IndexedCorpus) -> list[str]:
    """Every quote must be findable in the indexed chunks of its document, or the question can't be
    scored. Fails loudly instead of quietly lowering recall."""
    problems = []
    for q in questions:
        for item in q.evidence:
            for file, quote in item.alternatives:
                doc = corpus.documents.get(file)
                if doc is None:
                    problems.append(f"{q.id}: {file} was not indexed")
                elif not any(metrics.covers(c["content"], quote) for c in doc.chunks):
                    problems.append(f"{q.id}: quote not found in the indexed chunks of {file}: {quote[:70]!r}")
    return problems


# ---------- retrieval ----------

def run_retrieval(client: SmoiClient, questions: list[Question], modes: list[str], top_k: int = 10, log=print) -> dict:
    records: dict[str, list[dict]] = {}
    for mode in modes:
        client.search("warm-up query about frogs and databases", mode, top_k)  # load models before timing
        rows = []
        for q in questions:
            started = time.perf_counter()
            body = client.search(q.question, mode, top_k)
            wall_ms = (time.perf_counter() - started) * 1000
            results = body["results"]
            row = {
                "id": q.id, "group": q.group, "type": q.type, "mode": mode,
                "rerank": body.get("rerank"), "rerank_note": body.get("rerankNote"),
                "wall_ms": round(wall_ms, 1), "server_timings": body["timings"],
                "top": [{"rank": r["rank"], "file": r["filename"], "chunk_index": r["chunkIndex"]} for r in results],
            }
            if q.answerable:
                hits = evidence_hit_ranks([r["content"] for r in results], q.evidence)
                row.update({
                    "evidence_ranks": hits,
                    **{f"recall@{k}": metrics.recall_at_k(hits, k) for k in K_VALUES},
                    "mrr@10": metrics.reciprocal_rank(hits, 10),
                    "ndcg@10": metrics.ndcg_at_k(hits, 10),
                })
            rows.append(row)
        records[mode] = rows
        if mode == "hybrid_rerank":
            not_applied = [r["id"] for r in rows if r["rerank"] != "applied"]
            if not_applied:
                log(f"  WARNING: reranking was not applied for {len(not_applied)} questions; hybrid_rerank results are invalid")
        log(f"  {mode}: {len(rows)} queries")
    return records


def summarize_retrieval(records: dict[str, list[dict]]) -> dict:
    summary = {}
    for mode, rows in records.items():
        scored = [r for r in rows if "mrr@10" in r]
        summary[mode] = {
            "overall": _retrieval_metrics(scored),
            "by_group": {g: _retrieval_metrics([r for r in scored if r["group"] == g])
                         for g in sorted({r["group"] for r in scored})},
            "by_type": {t: _retrieval_metrics([r for r in scored if r["type"] == t])
                        for t in sorted({r["type"] for r in scored})},
            "latency_ms": {
                "wall_p50": metrics.percentile([r["wall_ms"] for r in rows], 50),
                "wall_p95": metrics.percentile([r["wall_ms"] for r in rows], 95),
                "server_p50": metrics.percentile([r["server_timings"]["totalMs"] for r in rows], 50),
                "server_p95": metrics.percentile([r["server_timings"]["totalMs"] for r in rows], 95),
                "queries": len(rows),
            },
            "rerank_applied": sum(r["rerank"] == "applied" for r in rows) if mode == "hybrid_rerank" else None,
        }
    return summary


def _retrieval_metrics(rows: list[dict]) -> dict:
    if not rows:
        return {"questions": 0}
    out = {"questions": len(rows)}
    for key in [f"recall@{k}" for k in K_VALUES] + ["mrr@10", "ndcg@10"]:
        out[key] = metrics.mean([r[key] for r in rows])
    return out


# ---------- answers ----------

def run_answers(client: SmoiClient, questions: list[Question], corpus: IndexedCorpus, mode: str, log=print) -> list[dict]:
    chunks = corpus.chunk_by_id()
    rows = []
    for n, q in enumerate(questions, start=1):
        started = time.perf_counter()
        try:
            status, body = client.query(q.question, mode)
        except (OSError, ApiError) as e:
            # One slow or failed request (for example a client timeout) is recorded, not fatal.
            status, body = 0, {"outcome": "harness_error", "answer": None, "error": str(e)[:300]}
        wall_ms = (time.perf_counter() - started) * 1000
        citations = body.get("citations") or []
        row = {
            "id": q.id, "group": q.group, "type": q.type, "mode": mode, "http_status": status,
            "outcome": body.get("outcome"), "answer": body.get("answer"),
            "citations": [{"label": c["label"], "chunk_id": c["chunkId"], "file": c["filename"],
                           "chunk_index": c["chunkIndex"]} for c in citations],
            "invalid_citations": body.get("invalidCitations") or [],
            "sources_given": body.get("sourcesGiven"), "omitted_for_context": body.get("omittedForContext"),
            "truncated": body.get("truncated"), "timings": body.get("timings"), "wall_ms": round(wall_ms, 1),
        }
        # Deterministic citation checks.
        row["citations_in_corpus"] = all(c["chunkId"] in chunks for c in citations)
        if q.answerable and row["outcome"] == "answered":
            covering = [any(metrics.covers(chunks[c["chunkId"]]["content"], quote)
                            for item in q.evidence for quote in item.quotes())
                        for c in citations if c["chunkId"] in chunks]
            row["cited_chunks_with_evidence"] = sum(covering)
            row["cited_chunks"] = len(covering)
        rows.append(row)
        log(f"  [{n}/{len(questions)}] {q.id} {row['outcome']} ({wall_ms / 1000:.1f} s)")
    return rows


def summarize_answers(rows: list[dict]) -> dict:
    def outcome_counts(subset):
        counts: dict[str, int] = {}
        for r in subset:
            counts[r["outcome"]] = counts.get(r["outcome"], 0) + 1
        return counts

    answerable = [r for r in rows if r["type"] != "not_answerable"]
    unanswerable = [r for r in rows if r["type"] == "not_answerable"]
    answered = [r for r in answerable if r["outcome"] == "answered"]
    cited = sum(r.get("cited_chunks", 0) for r in answered)

    def share(n, d):
        return n / d if d else None

    stage = {}
    for key in ["retrievalMs", "rerankMs", "firstTokenMs", "generationMs", "totalMs"]:
        values = [r["timings"][key] for r in rows if r.get("timings")]
        if values:
            stage[key] = {"p50": metrics.percentile(values, 50), "p95": metrics.percentile(values, 95)}

    return {
        "questions": len(rows),
        "outcomes": outcome_counts(rows),
        "outcomes_by_type": {t: outcome_counts([r for r in rows if r["type"] == t])
                             for t in sorted({r["type"] for r in rows})},
        # NFR-09.05
        "correct_dont_know_rate": share(sum(r["outcome"] == "dont_know" for r in unanswerable), len(unanswerable)),
        "answered_unanswerable_rate": share(sum(r["outcome"] == "answered" for r in unanswerable), len(unanswerable)),
        "false_dont_know_rate": share(sum(r["outcome"] == "dont_know" for r in answerable), len(answerable)),
        "answered_rate_answerable": share(len(answered), len(answerable)),
        # NFR-09.04: the backend rejects any citation that doesn't name a retrieved chunk; this counts
        # how often that happened, and checks that every accepted citation is one of the user's chunks.
        "citation_rejected_rate": share(sum(r["outcome"] == "citation_rejected" for r in rows), len(rows)),
        "accepted_citations_in_corpus": all(r["citations_in_corpus"] for r in rows if r["outcome"] == "answered"),
        # Deterministic citation correctness against the labelled evidence.
        "cited_chunk_evidence_precision": share(sum(r.get("cited_chunks_with_evidence", 0) for r in answered), cited),
        "answers_citing_evidence_rate": share(sum(r.get("cited_chunks_with_evidence", 0) > 0 for r in answered), len(answered)),
        "by_group": {g: {
            "correct_dont_know_rate": share(sum(r["outcome"] == "dont_know" for r in unanswerable if r["group"] == g),
                                            sum(r["group"] == g for r in unanswerable)),
            "false_dont_know_rate": share(sum(r["outcome"] == "dont_know" for r in answerable if r["group"] == g),
                                          sum(r["group"] == g for r in answerable)),
            "answers_citing_evidence_rate": share(sum(r.get("cited_chunks_with_evidence", 0) > 0 for r in answered if r["group"] == g),
                                                  sum(r["group"] == g for r in answered)),
        } for g in sorted({r["group"] for r in rows})},
        "latency_ms": stage,
    }


# ---------- faithfulness ----------

def answer_passages(row: dict, corpus: IndexedCorpus) -> tuple[list[str], list[tuple[str, str]], list[list[str]]]:
    """Sentences of an answer, the passages it cites (label, text), and each sentence's own labels."""
    chunks = corpus.chunk_by_id()
    by_label = {c["label"]: chunks[c["chunk_id"]]["content"] for c in row["citations"] if c["chunk_id"] in chunks}
    sentences = metrics.split_sentences(row["answer"] or "")
    return sentences, sorted(by_label.items()), [metrics.cited_labels(s) for s in sentences]


def run_judge(judge, questions: dict[str, Question], rows: list[dict], corpus: IndexedCorpus, log=print) -> list[dict]:
    judged = []
    targets = [r for r in rows if r["outcome"] == "answered"]
    for n, row in enumerate(targets, start=1):
        sentences, passages, _ = answer_passages(row, corpus)
        record = {"id": row["id"], "group": row["group"], "type": row["type"], "sentences": sentences}
        try:
            verdicts = judge.judge(questions[row["id"]].question, sentences, passages)
            record["verdicts"] = verdicts
            record["faithfulness"] = sum(v == "supported" for v in verdicts) / len(verdicts)
        except Exception as e:  # a judge failure is recorded, not fatal
            record["error"] = str(e)
        judged.append(record)
        log(f"  judged [{n}/{len(targets)}] {row['id']}: {record.get('faithfulness', record.get('error'))}")
    return judged


def summarize_judge(judged: list[dict]) -> dict:
    ok = [j for j in judged if "faithfulness" in j]
    return {
        "answers_judged": len(ok),
        "judge_errors": len(judged) - len(ok),
        "mean_faithfulness": metrics.mean([j["faithfulness"] for j in ok]) if ok else None,
        "fully_faithful_rate": (sum(j["faithfulness"] == 1 for j in ok) / len(ok)) if ok else None,
        "by_group": {g: metrics.mean([j["faithfulness"] for j in ok if j["group"] == g])
                     for g in sorted({j["group"] for j in ok})},
    }


def sample_for_labelling(rows: list[dict], n: int = 30, seed: int = 7) -> list[dict]:
    answered = sorted((r for r in rows if r["outcome"] == "answered"), key=lambda r: r["id"])
    rng = random.Random(seed)
    return sorted(rng.sample(answered, min(n, len(answered))), key=lambda r: r["id"])


# ---------- the worst questions ----------

def worst_questions(questions: dict[str, Question], retrieval: dict[str, list[dict]], answers: list[dict] | None,
                    mode: str, n: int = 10) -> list[dict]:
    """Scores each question 0..1 on what went wrong in the default mode, lowest first.

    Answerable: mean of recall@5, MRR@10, and (with answers) answered-at-all and cited-the-evidence.
    Not answerable: 1 if the reply was "don't know", else 0.
    """
    retr = {r["id"]: r for r in retrieval.get(mode, [])}
    ans = {r["id"]: r for r in answers or []}
    scored = []
    for qid, q in questions.items():
        problems, parts = [], []
        a = ans.get(qid)
        if q.answerable:
            r = retr.get(qid)
            if r:
                parts += [r["recall@5"], r["mrr@10"]]
                if r["recall@10"] < 1:
                    problems.append(f"{mode} found {r['recall@10'] * len(r['evidence_ranks']):.0f}/{len(r['evidence_ranks'])} evidence items in the top 10")
                elif r["mrr@10"] < 1:
                    problems.append(f"first evidence chunk at rank {round(1 / r['mrr@10'])}")
            if a:
                answered = a["outcome"] == "answered"
                parts.append(1.0 if answered else 0.0)
                if not answered:
                    problems.append(f"answer outcome {a['outcome']}")
                else:
                    good = a.get("cited_chunks_with_evidence", 0) > 0
                    parts.append(1.0 if good else 0.0)
                    if not good:
                        problems.append("no cited chunk contains the evidence")
        elif a:
            ok = a["outcome"] == "dont_know"
            parts.append(1.0 if ok else 0.0)
            if not ok:
                problems.append(f"unanswerable question got outcome {a['outcome']}")
        if parts:
            scored.append({"id": qid, "group": q.group, "type": q.type, "question": q.question,
                           "score": metrics.mean(parts), "problems": problems})
    scored.sort(key=lambda s: (s["score"], s["id"]))
    return scored[:n]
