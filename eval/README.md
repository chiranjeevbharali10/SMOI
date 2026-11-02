# eval

Python evaluation scripts. Every number quoted in the docs comes from a script here, and names
that script, its dataset version and the date it ran. Raw results are saved in `results/`.

Retrieval, citation and intent evaluation is built in Phase 3.

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
