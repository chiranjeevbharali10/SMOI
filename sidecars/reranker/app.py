"""Cross-encoder reranker for SMOI Brain.

POST /rerank {"query": "...", "passages": ["...", ...]}  ->  {"model": "...", "scores": [float, ...]}

A cross-encoder reads the query and one passage together and outputs a relevance score. That is
more accurate than comparing two separately computed embeddings, but it costs one model pass per
passage, so the backend only sends its top hybrid candidates. Scores are raw model outputs
(logits): higher means more relevant, and only the order matters.

The model is English-only (it was trained on MS MARCO English web search data).
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Callable

from fastapi import FastAPI
from pydantic import BaseModel, Field

MODEL_NAME = os.environ.get("RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L6-v2")
# Pinned model revision (a Hugging Face commit), so a re-download can't silently change results.
MODEL_REVISION = os.environ.get("RERANKER_MODEL_REVISION", "233902d25c440f23af6f7d6e94d2946bac0bee0a")

Scorer = Callable[[str, list[str]], list[float]]


def load_cross_encoder() -> Scorer:
    # Imported here so the API tests can run with a fake scorer and without PyTorch installed.
    from sentence_transformers import CrossEncoder

    model = CrossEncoder(MODEL_NAME, revision=MODEL_REVISION, device="cpu")

    def score(query: str, passages: list[str]) -> list[float]:
        return [float(s) for s in model.predict([(query, p) for p in passages], batch_size=32)]

    return score


class RerankRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    passages: list[str] = Field(max_length=200)


class RerankResponse(BaseModel):
    model: str
    scores: list[float]


def create_app(scorer_factory: Callable[[], Scorer] = load_cross_encoder) -> FastAPI:
    state: dict[str, Scorer] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        state["score"] = scorer_factory()  # load once at startup, not per request
        yield

    app = FastAPI(title="SMOI reranker", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "model": MODEL_NAME}

    # A plain `def` endpoint: FastAPI runs it in a thread pool, so the CPU-bound model call
    # doesn't block the event loop.
    @app.post("/rerank", response_model=RerankResponse)
    def rerank(request: RerankRequest) -> RerankResponse:
        scores = state["score"](request.query, request.passages) if request.passages else []
        return RerankResponse(model=MODEL_NAME, scores=scores)

    return app


app = create_app()
