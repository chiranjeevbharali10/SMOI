"""The question set: loading, validation and the fixed tuning/test split.

Questions live in one CSV (eval/data/questions_v1.csv) that the owner reviews in a spreadsheet:

    id, batch, group, type, tags, question, reference_answer, expected_source, author_notes, status, reviewer_notes

- type: factual, multi_document or not_answerable
- status: unreviewed, approve, fix or reject. Only "approve" counts towards reported results.
- expected_source: one evidence item per line, written "file | exact quoted text". A line starting
  with "or " is an alternative for the item above it (the same fact stated in another document);
  any one alternative is enough. not_answerable questions leave it empty.
"""

import csv
import hashlib
import json
import random
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

from .corpus import CORPUS_DIR, manifest
from .metrics import normalize

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
QUESTIONS = DATA_DIR / "questions_v1.csv"
SPLIT = DATA_DIR / "split_v1.json"
COLUMNS = ["id", "batch", "group", "type", "tags", "question", "reference_answer", "expected_source",
           "author_notes", "status", "reviewer_notes"]
TYPES = {"factual", "multi_document", "not_answerable"}
STATUSES = {"unreviewed", "approve", "fix", "reject"}


@dataclass(frozen=True)
class Evidence:
    """One fact the answer needs. Any of the alternatives (file, quote) counts as finding it."""
    alternatives: tuple[tuple[str, str], ...]

    def quotes(self) -> list[str]:
        return [q for _, q in self.alternatives]


@dataclass(frozen=True)
class Question:
    id: str
    batch: str
    group: str
    type: str
    tags: tuple[str, ...]
    question: str
    reference_answer: str
    evidence: tuple[Evidence, ...]
    status: str

    @property
    def answerable(self) -> bool:
        return self.type != "not_answerable"

    def files(self) -> set[str]:
        return {f for e in self.evidence for f, _ in e.alternatives}


def parse_evidence(cell: str) -> tuple[Evidence, ...]:
    items: list[list[tuple[str, str]]] = []
    for raw in cell.splitlines():
        line = raw.strip()
        if not line:
            continue
        alternative = line.lower().startswith("or ")
        if alternative:
            line = line[3:].strip()
        if "|" not in line:
            raise ValueError(f"Evidence line must be 'file | quote': {raw!r}")
        file, quote = (part.strip() for part in line.split("|", 1))
        if alternative:
            if not items:
                raise ValueError(f"'or' line with nothing before it: {raw!r}")
            items[-1].append((file, quote))
        else:
            items.append([(file, quote)])
    return tuple(Evidence(tuple(alts)) for alts in items)


def load(path: Path = QUESTIONS) -> list[Question]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    questions, seen = [], set()
    for n, row in enumerate(rows, start=2):
        if not (row.get("question") or "").strip():
            continue
        qid = row["id"].strip()
        where = f"{path.name} line {n} ({qid})"
        if not qid or qid in seen:
            raise ValueError(f"{where}: missing or duplicate id")
        seen.add(qid)
        qtype = row["type"].strip()
        status = (row.get("status") or "unreviewed").strip().lower() or "unreviewed"
        if qtype not in TYPES:
            raise ValueError(f"{where}: type must be one of {sorted(TYPES)}")
        if status not in STATUSES:
            raise ValueError(f"{where}: status must be one of {sorted(STATUSES)}")
        evidence = parse_evidence(row.get("expected_source") or "")
        if qtype == "not_answerable" and evidence:
            raise ValueError(f"{where}: a not_answerable question has no expected source")
        if qtype != "not_answerable" and not evidence:
            raise ValueError(f"{where}: an answerable question needs at least one expected source")
        if qtype == "multi_document" and len({f for e in evidence for f, _ in e.alternatives}) < 2:
            raise ValueError(f"{where}: a multi_document question needs evidence from at least two documents")
        questions.append(Question(qid, row["batch"].strip(), row["group"].strip(), qtype,
                                  tuple(t.strip() for t in (row.get("tags") or "").split(",") if t.strip()),
                                  row["question"].strip(), row["reference_answer"].strip(), evidence, status))
    return questions


# ---------- offline text of the corpus files, for validation ----------

def document_text(file: str) -> str:
    entry = next((d for d in manifest() if d["file"] == file), None)
    if entry is None:
        raise ValueError(f"Not a corpus file: {file}")
    path = CORPUS_DIR / "docs" / entry["group"] / file
    if path.suffix == ".txt":
        return path.read_text(encoding="utf-8")
    if path.suffix == ".docx":
        with zipfile.ZipFile(path) as zf:
            xml = zf.read("word/document.xml").decode("utf-8")
        return "\n".join(re.sub(r"<[^>]+>", "", p) for p in re.findall(r"<w:p>.*?</w:p>", xml))
    if path.suffix == ".pdf":
        # Our PDFs are written by build_corpus.py: one "(text) Tj" per line, Windows-1252.
        raw = path.read_bytes()
        lines = re.findall(rb"\(((?:\\.|[^\\)])*)\) Tj", raw)
        return "\n".join(re.sub(rb"\\(.)", rb"\1", line).decode("cp1252") for line in lines)
    raise ValueError(f"Unsupported file type: {file}")


def validate(questions: list[Question]) -> list[str]:
    """Problems with evidence quotes: a quote that isn't in its document makes the question unscorable."""
    problems, texts = [], {}
    for q in questions:
        for item in q.evidence:
            for file, quote in item.alternatives:
                if len(normalize(quote).split()) < 5:
                    problems.append(f"{q.id}: quote too short to match reliably: {quote!r}")
                if file not in texts:
                    try:
                        texts[file] = document_text(file)
                    except ValueError as e:
                        problems.append(f"{q.id}: {e}")
                        continue
                if normalize(quote) not in normalize(texts[file]):
                    problems.append(f"{q.id}: quote not found in {file}: {quote[:80]!r}")
    return problems


# ---------- the fixed split ----------

def make_split(questions: list[Question], test_share: float = 1 / 3, seed: int = 20261103) -> dict:
    """Assigns approved questions to tuning or test, stratified by group and type, so each set has
    the same mix. Written once and committed; later calls only add newly approved questions."""
    existing = json.loads(SPLIT.read_text(encoding="utf-8")) if SPLIT.exists() else {"tuning": [], "test": []}
    assigned = set(existing["tuning"]) | set(existing["test"])
    new = [q for q in questions if q.status == "approve" and q.id not in assigned]
    strata: dict[tuple[str, str], list[Question]] = {}
    for q in new:
        strata.setdefault((q.group, q.type), []).append(q)
    rng = random.Random(seed)
    for key in sorted(strata):
        members = sorted(strata[key], key=lambda q: hashlib.sha256(q.id.encode()).hexdigest())
        rng.shuffle(members)
        n_test = round(len(members) * test_share)
        existing["test"] += [q.id for q in members[:n_test]]
        existing["tuning"] += [q.id for q in members[n_test:]]
    existing["tuning"].sort()
    existing["test"].sort()
    existing["note"] = ("Fixed split of approved questions. Tune only on 'tuning'. Run 'test' once settings are "
                        "final; every test run is logged in eval/results/locked_runs.jsonl.")
    SPLIT.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
    return existing


def load_split() -> dict | None:
    return json.loads(SPLIT.read_text(encoding="utf-8")) if SPLIT.exists() else None
