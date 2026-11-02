# eval

Python evaluation scripts. Every number quoted in the docs comes from a script here, and names
that script, its dataset version and the date it ran. Raw results are saved in `results/`.

## Retrieval and answer evaluation (`run_eval.py`)

`run_eval.py` uses only the standard library. It drives the real backend over HTTP: it indexes the
demo corpus for a fresh user, runs the questions, deletes that user's documents, and saves every
per-question result in `results/`. `docs/benchmarks.md` is generated from those files. The method
and its trade-offs are in `docs/adr/0010-evaluation-method.md`.

```sh
make eval                                  # or: python eval/run_eval.py all
python eval/run_eval.py run --retrieval-only   # quick: retrieval metrics only (stack must be running)
python eval/run_eval.py sweep              # chunk-size experiment, retrieval only
python eval/run_eval.py report             # regenerate docs/benchmarks.md
python eval/run_eval.py validate           # check every evidence quote exists in its document
python -m unittest discover -s eval/tests  # unit tests for the scoring code
```

| Path | What |
| --- | --- |
| `corpus/` | 24 pinned Wikipedia articles (TXT, DOCX, PDF) in three groups; `build_corpus.py` rebuilds them; `SOURCES.md` gives licences |
| `data/questions_v1.csv` | the question set the owner reviews (status: `unreviewed`, `approve`, `fix`, `reject`) |
| `data/split_v1.json` | fixed tuning/test split of approved questions (`run_eval.py split`) |
| `data/ci_subset_v1.json` | the questions the CI retrieval check uses (never from the test set) |
| `thresholds.json` | minimum CI recall, taken from a measured run |
| `labels/` | the owner's hand labels for 30 judged answers (`run_eval.py label-sample`) |
| `results/` | raw results; `locked_runs.jsonl` logs every run of the locked test set |

**Reviewing questions.** Open `data/questions_v1.csv` in a spreadsheet. Each row has the question,
reference answer, expected source text (`file | exact quote`, one per line; `or` marks an alternative)
and type. Set `status` to `approve`, `fix` or `reject` and add notes in `reviewer_notes`. Only approved
questions count. Once a batch is approved, `run_eval.py split` assigns it to tuning or test.

**The faithfulness judge** defaults to the local `ollama:qwen3.5:4b`, a different model from the
answer model. For a Claude run: `pip install -r eval/requirements-claude-judge.txt`, set
`ANTHROPIC_API_KEY`, and pass `--judge anthropic:claude-sonnet-5-5`. Judged scores are always
reported as estimates, next to the judge's agreement with the hand labels.

## Local chat model benchmark

`bench_local_llm.py` (standard library only) compares Ollama chat models on grounded answers. For
each model it measures:

- time to first token
- output and prompt speed
- peak container memory
- six rule checks: correct facts, valid citations, "don't know" for the two unanswerable
  questions, and ignoring a prompt-injection source

The questions are in `data/local_llm_bench_v1.json` and use fictional facts, so a model can't answer
from memory. The rule checks are a smoke test, not a quality metric: with six questions they can
catch a broken model but can't rank two good ones.

```sh
docker compose up -d ollama
python eval/bench_local_llm.py --models qwen3.5:2b-q4_K_M qwen3.5:4b --docker-container smoi-ollama-1
```

### Run of 2026-11-02 (`results/local_llm_bench_20261102_202740.json`)

**Setup:**
- Ollama 0.40.13 in Docker Desktop, CPU only. The Docker VM had 8 GB of RAM and 20 CPUs of an
  i7-13650HX; the laptop's GPU was not available to the container.
- `num_ctx` 8192, `think: false`, model default sampling, seed 42.

| Model | Load | Median time to first token | Median output speed | Peak container memory | Checks |
| --- | --- | --- | --- | --- | --- |
| `qwen3.5:2b-q4_K_M` | 18.9 s | 2.25 s | 17.3 tok/s | 4035 MiB | 6/6 |
| `qwen3.5:4b` | 35.8 s | 6.19 s | 8.3 tok/s | 5261 MiB | 6/6 |

**Notes:**
- Prompts were at most 341 tokens and all fit the context.
- Neither model produced thinking output.
- Peak memory is for the whole Ollama container, which also held the embedding model; the
  container's baseline before the chat model was 1.7 to 2.3 GB.
- **Decision:** the 2b model is the default (`OLLAMA_CHAT_MODEL`), because both passed every check
  and the 2b was about twice as fast. See `docs/adr/0009-llm-providers.md`.

## Reranker latency

`bench_rerank_latency.py` (standard library only) times the reranker sidecar for a given number of
candidates, using passages of about 2,000 characters (one default 500-token chunk). It also checks
that the one relevant passage is ranked first. That check is a sanity test, not a quality measure.

```sh
docker run -d --rm -p 127.0.0.1:8001:8001 --name smoi-reranker-bench smoi-reranker:dev
python eval/bench_rerank_latency.py --candidates 10 30 50 --runs 20
```

### Run of 2026-11-02 (`results/rerank_latency_20261102_204423.json`)

**Setup:** `cross-encoder/ms-marco-MiniLM-L6-v2` on CPU in Docker Desktop (same machine as above),
20 requests per size after one warm-up. Container memory after the run: 469 MiB.

| Candidates | p50 | p95 | Relevant passage ranked first |
| --- | --- | --- | --- |
| 10 | 366 ms | 437 ms | 20/20 |
| 30 (default `RERANK_CANDIDATES`) | 1,099 ms | 1,142 ms | 20/20 |
| 50 | 1,724 ms | 1,823 ms | 20/20 |

Latency grows linearly, at about 37 ms per candidate. Whether reranking is worth this is decided in
Phase 3 by measuring retrieval quality with and without it.
