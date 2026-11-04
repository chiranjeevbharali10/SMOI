"""Email classification evaluation (NFR-09.07): per-class precision, recall and F1, and macro-F1.

The test set (eval/data/emails_v1.jsonl) is synthetic: every email was written for this test, with
made-up names and example.com-style addresses. No real email is used. Three items carry prompt
injection ("ignore your instructions...") and are labelled by what the email really is.

Each email is sent to the backend's POST /api/email/classify, the same classifier that sorts synced
mail (no tools, two output fields). An email the classifier leaves unclassified counts as wrong.
"""

import json
import time
from pathlib import Path

from .api import ApiError, SmoiClient

DATA = Path(__file__).resolve().parent.parent / "data" / "emails_v1.jsonl"
CLASSES = ["important", "recruitment", "academic", "personal", "promotional"]
UNCLASSIFIED = "unclassified"


def load(path: Path = DATA) -> list[dict]:
    items = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    for item in items:
        if item["label"] not in CLASSES:
            raise ValueError(f"{item['id']}: unknown label {item['label']!r}")
    return items


def metrics(pairs: list[tuple[str, str]]) -> dict:
    """pairs: (expected, predicted). Predicted may be UNCLASSIFIED, which never matches."""
    per_class = {}
    for c in CLASSES:
        tp = sum(1 for e, p in pairs if e == c and p == c)
        fp = sum(1 for e, p in pairs if e != c and p == c)
        fn = sum(1 for e, p in pairs if e == c and p != c)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_class[c] = {"precision": precision, "recall": recall, "f1": f1, "support": tp + fn}
    confusion = {e: {p: 0 for p in CLASSES + [UNCLASSIFIED]} for e in CLASSES}
    for e, p in pairs:
        confusion[e][p if p in confusion[e] else UNCLASSIFIED] += 1
    return {
        "per_class": per_class,
        "macro_f1": sum(v["f1"] for v in per_class.values()) / len(CLASSES),
        "accuracy": sum(1 for e, p in pairs if e == p) / len(pairs) if pairs else 0.0,
        "unclassified": sum(1 for _, p in pairs if p == UNCLASSIFIED),
        "confusion": confusion,
        "n": len(pairs),
    }


def classify_all(client: SmoiClient, items: list[dict], log) -> list[dict]:
    """Classifies every item, waiting out the backend's rate limit (HTTP 429) when it answers so."""
    out = []
    for i, item in enumerate(items, 1):
        started = time.monotonic()
        while True:
            try:
                _, body = client._json("POST", "/api/email/classify",
                                       {"from": item["from"], "subject": item["subject"], "body": item["body"]})
                break
            except ApiError as e:
                if e.status == 429:
                    time.sleep(5)
                    continue
                raise
        predicted = body.get("category") or UNCLASSIFIED
        out.append({"id": item["id"], "expected": item["label"], "predicted": predicted,
                    "ms": round((time.monotonic() - started) * 1000)})
        if i % 10 == 0:
            log(f"  classified {i}/{len(items)}")
    return out


def table(m: dict) -> str:
    lines = ["| Class | Precision | Recall | F1 | Emails |", "| --- | --- | --- | --- | --- |"]
    for c in CLASSES:
        v = m["per_class"][c]
        lines.append(f"| {c} | {v['precision']:.2f} | {v['recall']:.2f} | {v['f1']:.2f} | {v['support']} |")
    lines.append(f"| **macro** | | | **{m['macro_f1']:.2f}** | {m['n']} |")
    return "\n".join(lines)
