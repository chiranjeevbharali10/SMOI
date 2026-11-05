"""Uploads the demo corpus for a fresh eval user and waits until every document is indexed."""

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from .api import SmoiClient

CORPUS_DIR = Path(__file__).resolve().parent.parent / "corpus"


@dataclass
class IndexedDocument:
    file: str
    group: str
    title: str
    document_id: str
    chunks: list[dict] = field(default_factory=list)


@dataclass
class IndexedCorpus:
    documents: dict[str, IndexedDocument]   # by file name
    index_seconds: float

    def chunk_count(self) -> int:
        return sum(len(d.chunks) for d in self.documents.values())

    def chunk_by_id(self) -> dict[str, dict]:
        return {c["id"]: {**c, "file": d.file} for d in self.documents.values() for c in d.chunks}

    def group_of(self, file: str) -> str:
        return self.documents[file].group


def manifest() -> list[dict]:
    return json.loads((CORPUS_DIR / "manifest.json").read_text(encoding="utf-8"))["documents"]


def corpus_stats() -> dict:
    docs = manifest()
    sizes = [(CORPUS_DIR / "docs" / d["group"] / d["file"]).stat().st_size for d in docs]
    formats: dict[str, int] = {}
    for d in docs:
        ext = Path(d["file"]).suffix.lstrip(".")
        formats[ext] = formats.get(ext, 0) + 1
    return {"documents": len(docs), "bytes": sum(sizes), "formats": formats,
            "groups": sorted({d["group"] for d in docs})}


def ingest(client: SmoiClient, timeout_s: float = 1800, log=print) -> IndexedCorpus:
    started = time.monotonic()
    pending: dict[str, IndexedDocument] = {}
    for d in manifest():
        path = CORPUS_DIR / "docs" / d["group"] / d["file"]
        uploaded = client.retry_rate_limited(lambda: client.upload(path))
        pending[uploaded["id"]] = IndexedDocument(d["file"], d["group"], d["title"], uploaded["id"])
    log(f"Uploaded {len(pending)} documents; waiting for indexing")

    done: dict[str, IndexedDocument] = {}
    while pending:
        if time.monotonic() - started > timeout_s:
            raise TimeoutError(f"Indexing did not finish within {timeout_s:.0f} s: {[d.file for d in pending.values()]}")
        for document_id in list(pending):
            status = client.document(document_id)
            if status["status"] == "indexed":
                doc = pending.pop(document_id)
                doc.chunks = sorted(client.chunks(document_id), key=lambda c: c["index"])
                done[doc.file] = doc
                log(f"  indexed {doc.file}: {len(doc.chunks)} chunks")
            elif status["status"] == "failed":
                raise RuntimeError(f"Indexing failed for {pending[document_id].file}: {status.get('error')}")
        if pending:
            time.sleep(2)
    return IndexedCorpus(done, time.monotonic() - started)


def delete(client: SmoiClient, corpus: IndexedCorpus):
    for doc in corpus.documents.values():
        client.delete_document(doc.document_id)
