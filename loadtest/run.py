"""Load and failure tests for SMOI (standard library only; needs Docker).

    python loadtest/run.py query        # query throughput and latency, stub LLM, ramping 5 -> 40 users
    python loadtest/run.py search       # retrieval only (/api/search), same ramp
    python loadtest/run.py upload       # uploads at a fixed rate, then time until the queue drains
    python loadtest/run.py worker-kill  # upload load while the worker process is killed (SIGKILL) and restarted
    python loadtest/run.py llm-down     # stop Ollama: circuit breakers open, queries return passages
    python loadtest/run.py scale        # retrieval latency at 1k, 10k and 100k chunks (NFR-06.03)

Every run writes loadtest/results/<scenario>_<timestamp>.json with the k6 summary, container CPU and
memory samples, the settings used and the hardware. docs/performance.md quotes these files.

Throughput runs disable rate limiting (RATE_LIMIT_ENABLED=false) and use the stub LLM
(LLM_PROVIDER=stub), so they measure SMOI's own capacity: a CPU-only local model answers one
question in ~20 s and would be the only thing measured.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "loadtest" / "results"
K6_IMAGE = "grafana/k6:2.3.0"
NETWORK = "smoi_default"
BACKEND = "http://127.0.0.1:8080"
PROMETHEUS = "http://127.0.0.1:9090"

sys.path.insert(0, str(ROOT / "eval"))
from smoi_eval import environment  # noqa: E402  (hardware and git info, shared with the eval harness)


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def sh(args, env=None, check=True, capture=False):
    return subprocess.run(args, cwd=ROOT, env={**os.environ, **(env or {})}, check=check,
                          capture_output=capture, text=True)


def compose(args, env=None, profiles=()):
    prof = [x for p in profiles for x in ("--profile", p)]
    sh(["docker", "compose", *prof, *args], env=env)


def wait_http(url, timeout=300):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=3)
            return
        except Exception:
            time.sleep(2)
    raise TimeoutError(url)


def prom(query):
    url = f"{PROMETHEUS}/api/v1/query?" + urllib.parse.urlencode({"query": query})
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.load(r)["data"]["result"]


def psql(sql):
    out = sh(["docker", "compose", "exec", "-T", "db", "sh", "-c",
              'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -c "$0"', sql], capture=True)
    return [line.split("|") for line in out.stdout.strip().splitlines() if line]


class Stats(threading.Thread):
    """Samples `docker stats` every few seconds while a test runs."""

    def __init__(self, interval=3):
        super().__init__(daemon=True)
        self.interval, self.samples, self.stop = interval, [], threading.Event()

    def run(self):
        while not self.stop.is_set():
            out = sh(["docker", "stats", "--no-stream", "--format", "{{json .}}"], capture=True, check=False).stdout
            t = time.time()
            for line in out.splitlines():
                d = json.loads(line)
                if d["Name"].startswith("smoi-"):
                    self.samples.append({"t": t, "name": d["Name"], "cpu": float(d["CPUPerc"].rstrip("%")),
                                         "mem": d["MemUsage"].split("/")[0].strip()})
            self.stop.wait(self.interval)

    def summary(self):
        out = {}
        for s in self.samples:
            o = out.setdefault(s["name"], {"cpu_max": 0, "cpu_sum": 0, "n": 0, "mem_last": None})
            o["cpu_max"] = max(o["cpu_max"], s["cpu"])
            o["cpu_sum"] += s["cpu"]
            o["n"] += 1
            o["mem_last"] = s["mem"]
        return {k: {"cpu_avg_pct": round(v["cpu_sum"] / v["n"], 1), "cpu_max_pct": v["cpu_max"],
                    "mem_at_end": v["mem_last"]} for k, v in out.items()}


def k6(script, env, result_name):
    RESULTS.mkdir(exist_ok=True)
    args = ["docker", "run", "--rm", "--network", NETWORK,
            "-v", f"{ROOT / 'loadtest' / 'k6'}:/scripts:ro",
            "-v", f"{ROOT / 'eval' / 'corpus' / 'docs'}:/corpus:ro",
            "-v", f"{RESULTS}:/results"]
    for k, v in {**env, "RESULT_NAME": result_name}.items():
        args += ["-e", f"{k}={v}"]
    args += [K6_IMAGE, "run", "--quiet", f"/scripts/{script}"]
    sh(args, check=False)
    raw = RESULTS / f"{result_name}.json"
    data = json.loads(raw.read_text(encoding="utf-8"))
    raw.unlink()
    return data


def k6_digest(summary):
    m = summary["metrics"]
    dur = m["http_req_duration{expected_response:true}"]["values"] if "http_req_duration{expected_response:true}" in m \
        else m["http_req_duration"]["values"]
    out = {
        "requests": m["http_reqs"]["values"]["count"],
        "requests_per_second": round(m["http_reqs"]["values"]["rate"], 2),
        "failed_share": round(m["http_req_failed"]["values"]["rate"], 4),
        "latency_ms": {k: round(v, 1) for k, v in dur.items()},
        "max_vus": m.get("vus_max", {}).get("values", {}).get("max"),
    }
    if "smoi_server_total_ms" in m:
        out["server_total_ms"] = {k: round(v, 1) for k, v in m["smoi_server_total_ms"]["values"].items()}
    return out


def save(name, data):
    RESULTS.mkdir(exist_ok=True)
    data["environment"] = {"git": environment.git_info(), "hardware": environment.hardware(),
                           "finished": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    path = RESULTS / f"{name}_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.json"
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    log(f"Saved {path.relative_to(ROOT)}")
    return path


def start(llm="stub", rate_limit=False, split=False, extra=None):
    env = {"LLM_PROVIDER": llm, "RATE_LIMIT_ENABLED": str(rate_limit).lower(), **(extra or {})}
    services = ["db", "ollama", "prometheus", "grafana", "jaeger"]
    if split:
        sh(["docker", "compose", "stop", "backend"], check=False)
        compose(["up", "-d", *services, "backend-api", "backend-worker"], env, profiles=("split",))
    else:
        sh(["docker", "compose", "--profile", "split", "stop", "backend-api", "backend-worker"], check=False)
        compose(["up", "-d", *services, "backend"], env)
    wait_http(f"{BACKEND}/livez")
    return env


# ---------- scenarios ----------

def run_ramp(args, endpoint):
    settings = start(llm="stub")
    stages = json.loads(args.stages)
    stats = Stats(); stats.start()
    log(f"k6 {endpoint} ramp {stages}")
    summary = k6("query.js", {"ENDPOINT": endpoint, "MODE": args.mode, "USERS": str(args.users),
                              "STAGES": json.dumps(stages), "UNIQUE": "1" if args.unique else "0"}, f"{endpoint}_raw")
    stats.stop.set(); stats.join()
    return save(endpoint + (f"_{args.label}" if args.label else ""), {"scenario": endpoint, "settings": {**settings, "mode": args.mode, "users": args.users,
                                                             "stages": stages, "unique_questions": args.unique, "label": args.label, "stub_latency": os.environ.get("STUB_LLM_LATENCY", "PT0.2S")},
                           "k6": k6_digest(summary), "per_stage": per_stage_from_prometheus(endpoint),
                           "containers": stats.summary()})


def per_stage_from_prometheus(endpoint):
    """p95 per retrieval stage over the run, from the backend's own histograms."""
    try:
        rows = prom('histogram_quantile(0.95, sum by (le, stage) (rate(smoi_retrieval_stage_seconds_bucket[3m])))')
        return {r["metric"]["stage"]: round(float(r["value"][1]) * 1000, 1) for r in rows if r["value"][1] != "NaN"}
    except Exception as e:
        return {"error": str(e)}


def jobs_by_status(since):
    rows = psql(f"SELECT status, count(*) FROM ingestion_jobs WHERE created_at >= '{since}' GROUP BY status")
    return {status: int(n) for status, n in rows}


def wait_drained(since, timeout=1800):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        counts = jobs_by_status(since)
        if counts.get("queued", 0) + counts.get("running", 0) == 0:
            return time.monotonic() - t0, counts
        time.sleep(3)
    return None, jobs_by_status(since)


def run_upload(args, kill_worker=False):
    settings = start(llm="stub", split=kill_worker)
    since = psql("SELECT now()")[0][0]
    stats = Stats(); stats.start()
    killer = None
    if kill_worker:
        def kill():
            time.sleep(args.kill_after)
            log("SIGKILL backend-worker")
            sh(["docker", "kill", "--signal", "KILL", "smoi-backend-worker-1"], check=False)
            time.sleep(10)
            log("restarting backend-worker")
            sh(["docker", "start", "smoi-backend-worker-1"], check=False)
        killer = threading.Thread(target=kill); killer.start()
    t_start = time.monotonic()
    log(f"k6 upload {args.rate}/s for {args.duration}")
    summary = k6("upload.js", {"RATE": str(args.rate), "DURATION": args.duration}, "upload_raw")
    upload_seconds = time.monotonic() - t_start
    if killer:
        killer.join()
    log("waiting for the queue to drain")
    drain, counts = wait_drained(since)
    stats.stop.set(); stats.join()
    uploaded = int(summary["metrics"].get("smoi_uploaded", {}).get("values", {}).get("count", 0))
    docs = psql(f"SELECT status, count(*) FROM documents WHERE created_at >= '{since}' GROUP BY status")
    result = {"scenario": "worker-kill" if kill_worker else "upload",
              "settings": {**settings, "rate_per_s": args.rate, "duration": args.duration,
                           "split_processes": kill_worker, "kill_after_s": args.kill_after if kill_worker else None},
              "k6": k6_digest(summary), "uploads_accepted": uploaded,
              "seconds_after_load_until_queue_empty": round(drain, 1) if drain is not None else None,
              "documents_per_second_end_to_end": round(uploaded / (upload_seconds + drain), 2) if drain else None,
              "jobs_by_status": counts, "documents_by_status": {s: int(n) for s, n in docs},
              "containers": stats.summary()}
    if kill_worker:
        result["jobs_retried_after_kill"] = int(psql(
            f"SELECT count(*) FROM ingestion_jobs WHERE created_at >= '{since}' AND attempts > 1")[0][0])
        result["lost_jobs"] = uploaded - counts.get("succeeded", 0) - counts.get("dead", 0)
    return save(result["scenario"], result)


def run_llm_down(args):
    settings = start(llm="ollama", rate_limit=False)
    from smoi_eval.api import SmoiClient
    c = SmoiClient(BACKEND, timeout=300); c.register_and_login("llmdown")
    doc = c.upload(ROOT / "eval/corpus/docs/frogs/natterjack_toad.txt")
    while c.document(doc["id"])["status"] != "indexed":
        time.sleep(1)
    events = []

    def ask(label):
        t = time.perf_counter()
        status, body = c.query("Which toad is native to Ireland?", "hybrid")
        ms = round((time.perf_counter() - t) * 1000)
        state = {r["metric"]["name"]: r["metric"]["state"] for r in prom('resilience4j_circuitbreaker_state == 1')}
        events.append({"phase": label, "status": status, "outcome": body.get("outcome"), "ms": ms,
                       "fallback": body.get("message"), "passages": len(body.get("passages") or []), "breakers": state})
        log(f"{label}: {body.get('outcome')} in {ms} ms, breakers {state}")

    ask("ollama up")
    log("stopping ollama")
    compose(["stop", "ollama"])
    for i in range(8):
        ask(f"ollama down #{i + 1}")
        time.sleep(5.5)  # one scrape interval, so Prometheus sees the state
    log("starting ollama")
    compose(["start", "ollama"])
    time.sleep(35)  # wait-in-open is 30 s
    for i in range(3):
        ask(f"ollama back #{i + 1}")
        time.sleep(5.5)
    c.delete_document(doc["id"])
    return save("llm-down", {"scenario": "llm-down", "settings": settings, "events": events})


def run_scale(args):
    """Retrieval latency as the corpus grows. Synthetic chunks (random vectors, random words) are
    inserted directly for one test user, because embedding 100k real chunks on this CPU would take
    hours. Latency depends on row counts and index structure, which synthetic rows reproduce; recall
    on random vectors is meaningless, so only latency is reported."""
    start(llm="stub")
    from smoi_eval.api import SmoiClient
    c = SmoiClient(BACKEND); c.register_and_login("scale")
    user_id = psql(f"SELECT id FROM users WHERE email = (SELECT max(email) FROM users WHERE email LIKE 'scale-%')")[0][0]
    results = []
    sizes = [int(s) for s in args.sizes]
    current = 0
    for size in sizes:
        add = size - current
        log(f"inserting {add} synthetic chunks (total {size})")
        psql(f"""
            WITH doc AS (
              INSERT INTO documents (user_id, filename, media_type, size_bytes, content_sha256, content, status, chunk_count, version)
              VALUES ('{user_id}', 'synthetic-{size}.txt', 'text/plain', 0, md5(random()::text) || md5(random()::text), ''::bytea, 'indexed', {add}, 1)
              RETURNING id)
            INSERT INTO document_chunks (user_id, document_id, chunk_index, content, token_count, embedding, embedding_model)
            SELECT '{user_id}', doc.id, g,
                   (SELECT string_agg(w, ' ') FROM (SELECT (ARRAY['frog','toad','pond','database','index','planet','moon','ring','storm','ocean','winter','spawn','commit','page','tree','orbit'])[1 + floor(random()*16)::int] AS w, g FROM generate_series(1, 60)) x),
                   60,
                   (SELECT array_agg(random() - 0.5)::vector FROM generate_series(1, 768) WHERE g > 0),
                   'ollama/nomic-embed-text'
              FROM doc, generate_series(1, {add}) g""")
        psql("ANALYZE document_chunks")
        current = size
        per_mode = {}
        for mode in ["keyword", "vector", "hybrid"]:
            c.search("warm up frog pond", mode, 10)
            times = []
            for i in range(args.queries):
                t = time.perf_counter()
                body = c.search(f"frog pond storm {i}", mode, 10)
                times.append((time.perf_counter() - t) * 1000)
            times.sort()
            per_mode[mode] = {"p50_ms": round(times[len(times) // 2], 1),
                              "p95_ms": round(times[int(len(times) * 0.95) - 1], 1), "queries": len(times)}
            log(f"  {size}: {mode} p50 {per_mode[mode]['p50_ms']} ms p95 {per_mode[mode]['p95_ms']} ms")
        results.append({"chunks_for_user": size, "modes": per_mode})
    log("removing synthetic rows")
    psql(f"DELETE FROM document_chunks WHERE user_id = '{user_id}'")
    psql(f"DELETE FROM documents WHERE user_id = '{user_id}'")
    return save("scale", {"scenario": "scale", "queries_per_mode": args.queries, "results": results,
                          "note": "Synthetic chunks with random 768-d vectors and random words; latency only."})


def main():
    import urllib.parse  # noqa: F401  (used by prom)
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("scenario", choices=["query", "search", "upload", "worker-kill", "llm-down", "scale"])
    p.add_argument("--mode", default="hybrid")
    p.add_argument("--unique", action="store_true", help="every question different, so caches can't help")
    p.add_argument("--label", default="", help="added to the results file name, e.g. before / after")
    p.add_argument("--users", type=int, default=10)
    p.add_argument("--stages", default='[{"duration":"30s","target":5},{"duration":"30s","target":10},'
                                       '{"duration":"30s","target":20},{"duration":"30s","target":40}]')
    p.add_argument("--rate", type=int, default=2)
    p.add_argument("--duration", default="60s")
    p.add_argument("--kill-after", type=int, default=20)
    p.add_argument("--sizes", nargs="+", default=["1000", "10000", "100000"])
    p.add_argument("--queries", type=int, default=100)
    a = p.parse_args()
    {"query": lambda: run_ramp(a, "query"), "search": lambda: run_ramp(a, "search"),
     "upload": lambda: run_upload(a), "worker-kill": lambda: run_upload(a, kill_worker=True),
     "llm-down": lambda: run_llm_down(a), "scale": lambda: run_scale(a)}[a.scenario]()


if __name__ == "__main__":
    import urllib.parse
    main()
