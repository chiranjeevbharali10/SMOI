# SMOI performance

Every number here comes from `loadtest/run.py` and the result file it names, in `loadtest/results/`.
Phase 4 was cut short, so some scenarios have **not been measured yet**; they are listed at the end.

**Hardware.** Intel Core i7-13650HX (20 logical CPUs), 15.6 GiB RAM, Windows 11, Docker Desktop
28.5.2 with 20 CPUs and 7.6 GiB for the Docker VM. All containers, including Ollama, run on the CPU;
no GPU is used.

**Setup for throughput runs.**

- The stub LLM (`LLM_PROVIDER=stub`, 200 ms per answer) is used, so the runs measure SMOI rather
  than a CPU-bound model.
- Rate limiting is off, and the embedding model is `nomic-embed-text` in Ollama.
- Each k6 virtual user (VU) belongs to one of 10 users, each with 4 indexed documents.
- The default ramp is 5, 10, 20 and 40 VUs, 30 s each.

## Bottleneck: embedding the question

| Run (`loadtest/results/…`) | Workload | Requests/s | p50 | p95 | Embedding p95 |
| --- | --- | --- | --- | --- | --- |
| `search_baseline-repeated_20261102_195906.json` | search, 8 repeated questions | 34.7 | 219 ms | 703 ms | 698 ms |
| `search_baseline-unique_20261102_200223.json` | search, every question unique | 26.0 | 288 ms | 995 ms | 996 ms |
| `query_baseline-repeated_20261102_200514.json` | full answer, stub LLM | 26.1 | 311 ms | 735 ms | 623 ms |

- In every run, embedding the question took almost all of the request time. Keyword and vector SQL
  took 2 to 3 ms at p95 (per-stage histograms, read from Prometheus at the end of each run).
- During these runs Ollama used about 870 to 960% CPU, while the backend averaged 52% and Postgres
  10% (container samples in the result files).

**Tried and rejected: `OLLAMA_NUM_PARALLEL=4`**
(`search_parallel4-unique_20261102_200840.json`): 25.5 requests/s, p95 1,046 ms. No improvement,
because each embedding already uses all the cores. The setting stays at Ollama's default of 1.

**Fix: a per-user exact-match query embedding cache in Postgres** (ADR 0011).

| Run | Workload | Requests/s | p50 | p95 |
| --- | --- | --- | --- | --- |
| `search_cache-repeated_20261102_201410.json` | search, repeated questions | **1,096** (was 34.7) | 5.8 ms | **21 ms** (was 703) |
| `query_cache-repeated_20261102_201956.json` | full answer, stub LLM | **49.2** (was 26.1) | 204 ms | **206 ms** (was 735) |
| `search_cache-unique_20261102_201705.json` | search, every question unique | 22.9 (was 26.0) | 301 ms | 1,109 ms (was 995) |

- **Repeated questions:** the cache removes the bottleneck. A full answer now costs little more than
  the stub's 200 ms. In the cached search run Postgres became the busiest container, at about 237%
  CPU on average.
- **New questions: slightly worse.** A miss adds a lookup and an insert. The cache only helps when
  questions repeat. How often real users repeat a question is unknown.

## Where it breaks

`search_breakpoint-unique_20261102_202327.json`: unique questions, ramping 50, 100, 200 and 400 VUs.

- Throughput stayed at about 20 requests/s, with no failed requests.
- Latency rose with the queue: p50 4.3 s, p95 14.7 s, maximum 15.8 s.
- So it doesn't fail; it queues. Above about 20 to 25 new questions per second on this machine,
  waiting time grows with the number of concurrent users.
- The limit is the embedding model's CPU time, not the backend or the database.

## Uploads

`upload_20261102_202718.json`: 2 uploads per second for 60 s, from 5 users. Each upload is unique
text of about 1,500 words.

- All 121 uploads were accepted. Upload request p50 was 23 ms and p95 74 ms.
- All 121 ingestion jobs succeeded.
- The queue took 156.5 s after the load stopped to drain: about 0.55 documents per second end to
  end. Ollama was the busiest container again, at about 960% CPU on average.

## Not measured yet

These scenarios exist in `loadtest/run.py` but weren't completed when Phase 4 was paused:

- `worker-kill`: kill the worker process during upload load and check that no jobs are lost. The
  crash-recovery logic is covered by `IngestionReliabilityIT`, but not yet by this load test.
- `llm-down` against the live stack: stop Ollama and check that the breaker opens and passages are
  returned. This behaviour is covered by `ResilienceIT`.
- `scale`: retrieval latency at 1k, 10k and 100k chunks (NFR-06.03). Targets stay `TBD`.
