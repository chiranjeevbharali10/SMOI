"""SMOI evaluation harness (standard library only; a Claude judge run also needs eval/requirements-claude-judge.txt).

Commands:
  validate       check every evidence quote exists in its document (offline)
  split          assign approved questions to the fixed tuning/test split (adds new ones only)
  run            evaluate one question set against the running stack and save a results file
  sweep          retrieval only, at several chunk sizes (restarts the backend for each)
  report         write docs/benchmarks.md from the latest results files
  all            what `make eval` runs: bootstrap .env, start the stack, run, report
  label-sample   write 30 answered questions for the owner to label by hand (no judge scores shown)
  ci-subset      pick the CI questions (from the tuning split once it exists, never the test set)
  ci-check       retrieval-only run on the CI subset; fails if recall drops below eval/thresholds.json
  email          email classification on the synthetic set (NFR-09.07): per-class precision, recall,
                 F1 and macro-F1; writes eval/results/email_*.json and docs/email-classification.md
  brain          file-level search eval (eval/data/brain_v1.csv): recall@5, MRR@10, no-result accuracy and
                 latency per mode; writes eval/results/brain_<label>_*.json

Question sets: draft (every question not rejected; results marked DRAFT), tuning, test (the locked
set; each run is logged), ci (eval/data/ci_subset_v1.json). The default is tuning once a split
exists, otherwise draft. The test set only runs when asked for explicitly.
"""

import argparse
import csv
import hashlib
import json
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from smoi_eval import brain, corpus as corpus_mod, dataset, email_eval, environment, metrics, report, runner  # noqa: E402
from smoi_eval.api import SmoiClient  # noqa: E402
from smoi_eval.judge import make_judge  # noqa: E402

EVAL = Path(__file__).resolve().parent
RESULTS = EVAL / "results"
LABELS = EVAL / "labels" / "faithfulness_v1.csv"
LABEL_PASSAGES = EVAL / "labels" / "faithfulness_v1.passages.json"
LOCKED_LOG = RESULTS / "locked_runs.jsonl"
CI_SUBSET = EVAL / "data" / "ci_subset_v1.json"
THRESHOLDS = EVAL / "thresholds.json"
DEFAULT_JUDGE = "ollama:qwen3.5:4b"


def log(message: str):
    print(message, flush=True)


# ---------- question sets ----------

def select_questions(name: str) -> list[dataset.Question]:
    questions = dataset.load()
    split = dataset.load_split()
    if name == "draft":
        return [q for q in questions if q.status != "reject"]
    if name in ("tuning", "test"):
        if not split:
            sys.exit("No split yet: approve questions, then run `python eval/run_eval.py split`.")
        ids = set(split[name])
        chosen = [q for q in questions if q.id in ids]
        not_approved = [q.id for q in chosen if q.status != "approve"]
        if not_approved:
            sys.exit(f"Questions in the {name} split are no longer approved: {not_approved}")
        return chosen
    if name == "ci":
        ids = set(json.loads(CI_SUBSET.read_text(encoding="utf-8"))["ids"])
        return [q for q in questions if q.id in ids]
    sys.exit(f"Unknown question set {name!r}")


def default_set() -> str:
    return "tuning" if dataset.load_split() else "draft"


def question_status() -> dict:
    questions = dataset.load()
    counts = {s: sum(q.status == s for q in questions) for s in dataset.STATUSES}
    return {**counts, "total": len(questions)}


# ---------- helpers ----------

def connect(args) -> SmoiClient:
    client = SmoiClient(args.backend_url)
    client.wait_until_up()
    return client


def fingerprint(providers: dict, answer_mode: str, rerank_candidates: int, git: dict) -> str:
    settings = {"providers": providers, "answer_mode": answer_mode, "rerank_candidates": rerank_candidates,
                "backend_tree": git["backend_tree"], "reranker_tree": git["reranker_tree"],
                "prompt_and_harness": hashlib.sha256((EVAL / "smoi_eval" / "runner.py").read_bytes()).hexdigest()}
    return hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest()


def save(prefix: str, data: dict) -> Path:
    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"{prefix}_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.json"
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def latest(prefix: str) -> Path | None:
    files = sorted(RESULTS.glob(f"{prefix}_*.json"))
    return files[-1] if files else None


def locked_log() -> list[dict]:
    if not LOCKED_LOG.exists():
        return []
    return [json.loads(line) for line in LOCKED_LOG.read_text(encoding="utf-8").splitlines() if line.strip()]


# ---------- commands ----------

def cmd_validate(args):
    questions = dataset.load()
    problems = dataset.validate(questions)
    for p in problems:
        log(p)
    status = question_status()
    log(f"{len(questions)} questions, {len(problems)} problems; status: "
        + ", ".join(f"{k} {v}" for k, v in status.items() if k != "total"))
    return 1 if problems else 0


def cmd_split(args):
    questions = dataset.load()
    if not any(q.status == "approve" for q in questions):
        sys.exit("No approved questions yet.")
    split = dataset.make_split(questions)
    log(f"Split written to {dataset.SPLIT}: {len(split['tuning'])} tuning, {len(split['test'])} test")
    return 0


def evaluate(args, client: SmoiClient, question_set: str, with_answers: bool, judge_spec: str | None) -> Path:
    questions = select_questions(question_set)
    problems = dataset.validate(questions)
    if problems:
        sys.exit("Fix the question set first:\n" + "\n".join(problems))
    email = client.register_and_login("eval")
    providers = client.providers()
    git = environment.git_info()
    judge = None
    judge_info = None
    if with_answers and judge_spec:
        judge_model = judge_spec.partition(":")[2]
        if judge_model == providers["llm"]["model"]:
            sys.exit(f"The judge ({judge_model}) must not be the model that writes the answers.")
        judge = make_judge(judge_spec, args.ollama_url)
        same_family = "qwen" in judge_model.lower() and "qwen" in providers["llm"]["model"].lower()
        judge_info = {"spec": judge_spec,
                      "note": ("A different model from the answer model, but both are from the Qwen family, so they may "
                               "share blind spots." if same_family else "A different model from the answer model.")
                              + " Its scores are an estimate."}

    log(f"Eval user {email}; indexing the corpus")
    corpus = corpus_mod.ingest(client, log=log)
    try:
        missing = runner.check_evidence_indexed(questions, corpus)
        if missing:
            sys.exit("Evidence not found in the indexed chunks (did parsing or chunking lose text?):\n" + "\n".join(missing))
        answerable = [q for q in questions if q.answerable]
        log(f"Retrieval: {len(questions)} questions x {len(args.modes)} modes")
        retrieval = runner.run_retrieval(client, questions, args.modes, log=log)
        result = {
            "run": {"question_set": question_set, "questions": len(questions), "answerable": len(answerable),
                    "answer_mode": args.answer_mode, "rerank_candidates": args.rerank_candidates,
                    "providers": providers, "started": datetime.now(timezone.utc).isoformat(timespec="seconds")},
            "environment": {"git": git, "hardware": environment.hardware()},
            "corpus": {**corpus_mod.corpus_stats(), "chunks": corpus.chunk_count(), "index_seconds": corpus.index_seconds},
            "retrieval": {"summary": runner.summarize_retrieval(retrieval), "per_question": retrieval},
        }
        answers = None
        if with_answers:
            log(f"Answers: {len(questions)} questions, mode {args.answer_mode}")
            answers = runner.run_answers(client, questions, corpus, args.answer_mode, log=log)
            result["answers"] = {"summary": runner.summarize_answers(answers), "per_question": answers}
            # Kept so cited passages can be shown later (hand labelling) after the eval user's documents are deleted.
            chunks = corpus.chunk_by_id()
            cited = sorted({c["chunk_id"] for r in answers for c in r["citations"] if c["chunk_id"] in chunks})
            result["cited_chunk_texts"] = [{"chunk_id": i, "file": chunks[i]["file"], "content": chunks[i]["content"]}
                                           for i in cited]
            if judge:
                unload_answer_model(args, providers)
                by_id = {q.id: q for q in questions}
                judged = runner.run_judge(judge, by_id, answers, corpus, log=log)
                result["judge"] = {**judge_info, "summary": runner.summarize_judge(judged), "per_answer": judged,
                                   "agreement": label_agreement(judge)}
                judge.unload()
        result["worst"] = runner.worst_questions({q.id: q for q in questions}, retrieval, answers, args.answer_mode)
    finally:
        corpus_mod.delete(client, corpus)
    path = save(f"run_{question_set}", result)
    log(f"Results: {path}")
    if question_set == "test":
        entry = {"timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"), "commit": git["commit"],
                 "fingerprint": fingerprint(providers, args.answer_mode, args.rerank_candidates, git),
                 "results": path.relative_to(environment.REPO).as_posix()}
        with LOCKED_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        log("Logged in eval/results/locked_runs.jsonl")
    return path


def unload_answer_model(args, providers):
    """Frees the answer model's memory before the judge loads (the Docker VM has limited RAM)."""
    if providers["llm"]["provider"] != "ollama":
        return
    try:
        from smoi_eval.judge import OllamaJudge
        OllamaJudge(providers["llm"]["model"], args.ollama_url).unload()
    except OSError as e:
        log(f"  could not unload {providers['llm']['model']}: {e}")


def label_agreement(judge) -> dict | None:
    """Judges the owner's hand-labelled sample and compares verdicts sentence by sentence."""
    if not LABELS.exists() or not LABEL_PASSAGES.exists():
        return None
    with LABELS.open(encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.DictReader(f) if r["your_label"].strip().lower() in ("supported", "not_supported")]
    if not rows:
        return None
    samples = json.loads(LABEL_PASSAGES.read_text(encoding="utf-8"))
    human, machine = [], []
    for sample_id in sorted({r["sample_id"] for r in rows}):
        s = samples[sample_id]
        verdicts = judge.judge(s["question"], s["sentences"], [tuple(p) for p in s["passages"]])
        for r in (r for r in rows if r["sample_id"] == sample_id):
            human.append(r["your_label"].strip().lower())
            machine.append(verdicts[int(r["sentence_no"]) - 1])
    agree = sum(h == m for h, m in zip(human, machine))
    return {"sentences": len(human), "percent": agree / len(human), "kappa": metrics.cohen_kappa(human, machine)}


def cmd_run(args):
    client = connect(args)
    evaluate(args, client, args.set or default_set(), not args.retrieval_only, None if args.judge == "none" else args.judge)
    return 0


def cmd_sweep(args):
    question_set = args.set or default_set()
    questions = select_questions(question_set)
    answerable = [q for q in questions if q.answerable]
    configs = []
    try:
        for size in args.sizes:
            overlap = round(size * 0.15)
            log(f"Chunk size {size}, overlap {overlap}: restarting the backend")
            environment.start_stack(size, overlap, rerank="hybrid_rerank" in args.modes, build=False)
            client = connect(args)
            client.register_and_login("sweep")
            providers = client.providers()
            if providers["chunking"]["maxTokens"] != size:
                sys.exit(f"Backend reports chunk size {providers['chunking']['maxTokens']}, expected {size}")
            corpus = corpus_mod.ingest(client, log=log)
            try:
                missing = runner.check_evidence_indexed(answerable, corpus)
                if missing:
                    log("  WARNING: " + "; ".join(missing))
                retrieval = runner.run_retrieval(client, answerable, args.modes, log=log)
            finally:
                corpus_mod.delete(client, corpus)
            configs.append({"chunk_tokens": size, "chunk_overlap": overlap, "chunks": corpus.chunk_count(),
                            "index_seconds": corpus.index_seconds, "summary": runner.summarize_retrieval(retrieval),
                            "per_question": retrieval})
    finally:
        log("Restoring the default chunk size (500 / 75)")
        environment.start_stack(500, 75, rerank=True, build=False)
    path = save(f"sweep_{question_set}", {"question_set": question_set, "answerable": len(answerable),
                                          "commit": environment.git_info()["commit"], "configs": configs})
    log(f"Results: {path}")
    return 0


def cmd_report(args):
    results = Path(args.results) if args.results else (latest("run_test") or latest("run_tuning") or latest("run_draft"))
    if not results:
        sys.exit("No results files yet; run `python eval/run_eval.py run` first.")
    sweep = Path(args.sweep) if args.sweep else latest("sweep_" + json.loads(results.read_text(encoding="utf-8"))["run"]["question_set"])
    path = report.write(results, sweep, locked_log(), question_status())
    log(f"Wrote {path}")
    return 0


def cmd_bootstrap_env(args):
    """Creates .env from .env.example with freshly generated local secrets, if .env doesn't exist."""
    env_file = environment.REPO / ".env"
    if env_file.exists():
        log(".env exists; leaving it alone")
        return 0
    lines = []
    for line in (environment.REPO / ".env.example").read_text(encoding="utf-8").splitlines():
        if line.startswith("JWT_SECRET="):
            import base64
            line = "JWT_SECRET=" + base64.b64encode(secrets.token_bytes(32)).decode()
        elif line.startswith("POSTGRES_PASSWORD="):
            line = "POSTGRES_PASSWORD=" + secrets.token_urlsafe(24)
        elif line.startswith("GRAFANA_ADMIN_PASSWORD="):
            line = "GRAFANA_ADMIN_PASSWORD=" + secrets.token_urlsafe(18)
        lines.append(line)
    env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log("Created .env with generated local secrets (never commit it)")
    return 0


def cmd_all(args):
    cmd_bootstrap_env(args)
    log("Starting the stack (db, ollama, backend, reranker)")
    environment.start_stack(500, 75, rerank=True, build=True)
    client = connect(args)
    path = evaluate(args, client, args.set or default_set(), True, None if args.judge == "none" else args.judge)
    args.results, args.sweep = str(path), None
    code = cmd_report(args)
    cmd_email(args)
    return code


def cmd_email(args):
    """Email classification on the synthetic set, through the running backend's classifier."""
    client = connect(args)
    client.register_and_login("eval-email")
    providers = client.providers()
    items = email_eval.load()
    log(f"Classifying {len(items)} synthetic emails with {providers.get('llm', providers)}")
    rows = email_eval.classify_all(client, items, log)
    m = email_eval.metrics([(r["expected"], r["predicted"]) for r in rows])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"email_{stamp}.json"
    out.write_text(json.dumps({
        "run": {"at": stamp, "dataset": "eval/data/emails_v1.jsonl", "providers": providers,
                "git": environment.git_info(), "hardware": environment.hardware()},
        "metrics": m, "items": rows,
    }, indent=2), encoding="utf-8")
    doc = environment.REPO / "docs" / "email-classification.md"
    lines = [
        "# Email classification (NFR-09.07)",
        "",
        "Generated by `python eval/run_eval.py email` (also part of `make eval`). Do not edit by hand.",
        "",
        f"- Run: {stamp} UTC, results file `eval/results/{out.name}`",
        f"- Test set: `eval/data/emails_v1.jsonl`, {m['n']} synthetic emails (no real mail), including 3 with "
        "injected instructions, labelled by what they really are",
        f"- Model: `{json.dumps(providers.get('llm', providers))}`",
        f"- Accuracy {m['accuracy']:.2f}; unclassified {m['unclassified']} (counted as wrong)",
        "",
        email_eval.table(m),
        "",
        "Synthetic emails are cleaner than real mail, so treat these numbers as an upper bound for a real inbox. "
        "NFR-09.07 keeps its target as TBD until the owner sets one.",
        "",
    ]
    doc.write_text("\n".join(lines), encoding="utf-8")
    log(email_eval.table(m))
    log(f"Wrote {out} and {doc}")
    return 0


def cmd_label_sample(args):
    if LABELS.exists():
        sys.exit(f"{LABELS} already exists; labels are only drawn once so they stay comparable.")
    results = Path(args.results) if args.results else (latest("run_tuning") or latest("run_draft"))
    data = json.loads(results.read_text(encoding="utf-8"))
    rows = data["answers"]["per_question"]
    questions = {q.id: q for q in dataset.load()}
    sample = runner.sample_for_labelling(rows, args.n)
    # The passages each answer cited, as saved in the results file of the run that produced the answers.
    chunk_text = {c["chunk_id"]: c["content"] for c in data.get("cited_chunk_texts", [])}
    LABELS.parent.mkdir(exist_ok=True)
    machine = {}
    with LABELS.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["sample_id", "question_id", "question", "sentence_no", "sentence", "cited_passages",
                    "your_label", "notes"])
        for n, row in enumerate(sample, start=1):
            sample_id = f"s{n:02d}"
            sentences = metrics.split_sentences(row["answer"])
            passages = [(c["label"], chunk_text[c["chunk_id"]]) for c in row["citations"] if c["chunk_id"] in chunk_text]
            passages = sorted(dict(passages).items())
            machine[sample_id] = {"question_id": row["id"], "question": questions[row["id"]].question,
                                  "sentences": sentences, "passages": passages}
            joined = "\n\n".join(f"[{label}] {text}" for label, text in passages)
            for i, sentence in enumerate(sentences, start=1):
                w.writerow([sample_id, row["id"], questions[row["id"]].question, i, sentence,
                            joined if i == 1 else "(same as sentence 1)", "", ""])
    LABEL_PASSAGES.write_text(json.dumps(machine, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"Wrote {LABELS} ({len(sample)} answers). Label each sentence 'supported' or 'not_supported'.")
    return 0


def cmd_ci_subset(args):
    """Picks the CI questions: answerable ones, spread over groups and types, never from the locked test set."""
    questions = dataset.load()
    split = dataset.load_split()
    if split:
        pool, source = [q for q in questions if q.id in set(split["tuning"])], "tuning split"
    else:
        pool, source = [q for q in questions if q.status != "reject"], "draft questions (re-pick from the tuning split once it exists)"
    pool = [q for q in pool if q.answerable]
    by_stratum: dict = {}
    for q in sorted(pool, key=lambda q: hashlib.sha256(q.id.encode()).hexdigest()):
        by_stratum.setdefault((q.group, q.type), []).append(q)
    chosen = []
    while len(chosen) < args.n and any(by_stratum.values()):
        for key in sorted(by_stratum):
            if by_stratum[key] and len(chosen) < args.n:
                chosen.append(by_stratum[key].pop(0))
    CI_SUBSET.write_text(json.dumps({"source": source, "ids": sorted(q.id for q in chosen)}, indent=2) + "\n",
                         encoding="utf-8")
    log(f"Wrote {CI_SUBSET}: {len(chosen)} questions from the {source}")
    return 0


def cmd_ci_check(args):
    if not THRESHOLDS.exists():
        sys.exit("eval/thresholds.json is missing")
    thresholds = json.loads(THRESHOLDS.read_text(encoding="utf-8"))
    client = connect(args)
    args.modes = [thresholds["mode"]]
    path = evaluate(args, client, "ci", with_answers=False, judge_spec=None)
    summary = json.loads(path.read_text(encoding="utf-8"))["retrieval"]["summary"][thresholds["mode"]]["overall"]
    failed = []
    for metric, minimum in thresholds["minimum"].items():
        value = summary[metric]
        log(f"{thresholds['mode']} {metric}: {value:.3f} (minimum {minimum:.3f})")
        if value < minimum:
            failed.append(metric)
    if failed:
        log(f"FAILED: {', '.join(failed)} below threshold")
        return 1
    log("Retrieval quality is within thresholds")
    return 0


def cmd_brain(args):
    """File-level search eval for the brain upgrade. Uploads the demo corpus for a fresh user."""
    queries = brain.load()
    problems = brain.validate(queries)
    if problems:
        sys.exit("Fix eval/data/brain_v1.csv first:\n" + "\n".join(problems))
    client = connect(args)
    email = client.register_and_login("eval-brain")
    providers = client.providers()
    modes = list(args.modes)
    if "hybrid_rerank" in modes and not providers.get("reranker", {}).get("enabled", False):
        log("Reranker is not enabled in this stack; skipping hybrid_rerank")
        modes.remove("hybrid_rerank")
    log(f"Eval user {email}; indexing the corpus")
    corpus = corpus_mod.ingest(client, log=log)
    try:
        log(f"Search: {len(queries)} queries x {len(modes)} modes")
        records = brain.run(client, queries, modes, log=log)
    finally:
        corpus_mod.delete(client, corpus)
    summary = brain.summarize(records)
    result = {"run": {"label": args.label, "queries": len(queries), "modes": modes, "providers": providers,
                      "started": datetime.now(timezone.utc).isoformat(timespec="seconds")},
              "environment": {"git": environment.git_info(), "hardware": environment.hardware()},
              "corpus": {**corpus_mod.corpus_stats(), "chunks": corpus.chunk_count(), "index_seconds": corpus.index_seconds},
              "summary": summary, "misses": brain.misses(records), "per_query": records}
    path = save(f"brain_{args.label}", result)
    for mode, s in summary.items():
        o = s["overall"]
        log(f"  {mode:14} recall@5 {o['recall@5']:.3f}  MRR@10 {o['mrr@10']:.3f}  "
            f"no-result correct {s['no_result']['correctly_empty']:.3f}  mean latency {s['latency_ms']['wall_mean']:.0f} ms")
    log(f"Results: {path}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backend-url", default="http://127.0.0.1:8080")
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    sub = parser.add_subparsers(dest="command", required=True)

    def run_options(p):
        p.add_argument("--set", choices=["draft", "tuning", "test", "ci"])
        p.add_argument("--modes", nargs="+", default=runner.MODES, choices=runner.MODES)
        p.add_argument("--answer-mode", default="hybrid", choices=runner.MODES)
        p.add_argument("--rerank-candidates", type=int, default=30, help="must match RERANK_CANDIDATES in the stack")
        p.add_argument("--judge", default=DEFAULT_JUDGE, help="ollama:<model>, anthropic:<model> or none")

    sub.add_parser("validate").set_defaults(func=cmd_validate)
    sub.add_parser("split").set_defaults(func=cmd_split)
    p = sub.add_parser("run")
    run_options(p)
    p.add_argument("--retrieval-only", action="store_true")
    p.set_defaults(func=cmd_run)
    p = sub.add_parser("sweep")
    run_options(p)
    p.add_argument("--sizes", nargs="+", type=int, default=[250, 500, 800])
    p.set_defaults(func=cmd_sweep)
    p = sub.add_parser("report")
    p.add_argument("--results")
    p.add_argument("--sweep")
    p.set_defaults(func=cmd_report)
    p = sub.add_parser("all")
    run_options(p)
    p.set_defaults(func=cmd_all)
    p = sub.add_parser("label-sample")
    p.add_argument("--results")
    p.add_argument("--n", type=int, default=30)
    p.set_defaults(func=cmd_label_sample)
    p = sub.add_parser("ci-subset")
    p.add_argument("--n", type=int, default=20)
    p.set_defaults(func=cmd_ci_subset)
    p = sub.add_parser("ci-check")
    run_options(p)
    p.set_defaults(func=cmd_ci_check)
    sub.add_parser("bootstrap-env").set_defaults(func=cmd_bootstrap_env)
    sub.add_parser("email").set_defaults(func=cmd_email)
    p = sub.add_parser("brain")
    p.add_argument("--label", default="run", help="name in the results file, e.g. baseline")
    p.add_argument("--modes", nargs="+", default=runner.MODES, choices=runner.MODES)
    p.set_defaults(func=cmd_brain)

    args = parser.parse_args()
    started = time.monotonic()
    code = args.func(args)
    log(f"Done in {time.monotonic() - started:.0f} s")
    sys.exit(code)


if __name__ == "__main__":
    main()
