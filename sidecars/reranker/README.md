# Reranker sidecar

A FastAPI service that scores (query, passage) pairs with the cross-encoder
`cross-encoder/ms-marco-MiniLM-L6-v2` (Apache 2.0, pinned revision). The backend calls it in the
`hybrid_rerank` retrieval mode, behind the `Reranker` interface. If it is down or slow, retrieval
falls back to the hybrid order and reports `rerank: "skipped"`.

Known limitation: the model is English-only.

- Run with Docker Compose: `docker compose --profile rerank up` (see the repository README).
- API tests (fake scorer, no PyTorch needed):

  ```sh
  cd sidecars/reranker
  python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # .venv/bin/pip on Linux/macOS
  .venv/Scripts/python -m pytest
  ```
