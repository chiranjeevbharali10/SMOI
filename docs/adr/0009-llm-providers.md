# 0009: LLM providers: local Ollama by default, Claude Haiku 5.5 opt-in, per-document consent

- Status: Accepted
- Date: 2026-11-02

## Context

Answers, summaries and comparisons need a chat model. The user's documents are private, and
NFR-04.05 requires a local-only option. A hosted model writes better answers but sends text off the
machine and costs money. Both must sit behind an interface chosen by configuration (CLAUDE.md).

## Decision

**`LlmProvider` interface** with two implementations, chosen by `smoi.llm.provider`.

**`ollama` (default, local)**

- Calls `POST /api/chat` with streaming.
- `num_ctx` is set explicitly (default 8192), because Ollama truncates longer prompts without an
  error. The prompt budget is `num_ctx` minus the output limit.
- After each call, the provider checks Ollama's `prompt_eval_count`. If the prompt filled the context,
  it raises `ContextOverflowException` instead of returning an answer built on a cut prompt.
- `think: false` turns off the reasoning trace, which would cost time without being shown.
- The default model is **`qwen3.5:2b-q4_K_M`** (Apache 2.0, 1.95 GB download), chosen with
  `eval/bench_local_llm.py`; see `eval/README.md` for the run.
  - Both candidates (2b and 4b) passed all six smoke checks.
  - The 2b was about twice as fast on this CPU-only setup, so it is the default.
  - The model is a config value (`OLLAMA_CHAT_MODEL`).

**`anthropic` (opt-in, hosted)**

- Uses the official Java SDK (`com.anthropic:anthropic-java`) with **`claude-haiku-5-5`** by default
  (`ANTHROPIC_MODEL`).
- Model-specific handling for Haiku 5.5:
  - No `temperature`, `top_p` or `top_k` is sent; Haiku 5.5 rejects non-default values.
  - Thinking is left at the model's adaptive default, `effort` is configurable (default `medium`),
    and only text blocks are read from the reply.
  - The output limit leaves room for thinking tokens.
  - `stop_reason: "refusal"` arrives as HTTP 200. It becomes its own outcome (`refused`, with the
    provider's category), is shown to the user as a refusal, and is counted separately. It is never
    treated as an answer.
  - There is no server-side fallback, because Haiku 5.5 doesn't support one.
  - The prompt budget is 32K tokens, below the 100K-token threshold where Haiku 5.5's higher price
    tier starts.
- `AnthropicLiveIT` checks the features we rely on against the real API: system prompt, streaming,
  effort without sampling parameters, stop reason. It only runs when `ANTHROPIC_API_KEY` is set.

**Per-document consent.** `documents.hosted_llm_allowed` is **off by default**
(`PATCH /api/documents/{id}`).

- With a hosted provider, retrieval only searches allowed documents.
- The answer reports how many documents were excluded.
- Summary and compare return 403 for a document that isn't allowed.
- The local provider ignores the setting.

`GET /api/settings/providers` shows the active providers and whether each sends text off the machine.
Every answer records its provider and model, and Phase 3 benchmarks must report them too.

## Alternatives rejected

- **Claude as the default.** Better answers, but every question would send document text to a cloud
  service, and the user would need a paid API key before SMOI works at all.
- **A larger local model (`qwen3.5:4b`).** It passed the same checks but was about half as fast, with
  6 s to the first token on this machine's CPU.
- **Claude Opus or Sonnet by default.** Several times the cost of Haiku 5.5 per token. If Phase 3
  shows Haiku's answers are weak, `claude-sonnet-5-5` is the comparison to run.
- **An OpenAI-compatible abstraction (one client for every provider).** It flattens provider details
  that matter here: refusals as a distinct stop reason, rejected sampling parameters, thinking blocks.
- **Consent per request instead of per document.** Easy to forget on any one request. A per-document
  setting matches how people think about sensitive files.

## Consequences

- **Answer quality depends on the provider.** The local 2b model is small; Phase 3 measures it.
- **The local benchmark ran CPU-only.** The machine's NVIDIA GPU isn't passed into Docker. GPU
  passthrough, or a native Windows Ollama via `OLLAMA_BASE_URL`, would change the speed numbers.
- **The Claude path has only been checked against documentation so far.** `AnthropicLiveIT` is
  skipped until a key is configured.
- **Text sent to Claude is subject to Anthropic's data retention.** That is why consent is per
  document and off by default.
