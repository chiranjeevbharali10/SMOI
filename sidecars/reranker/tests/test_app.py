"""API tests with a fake scorer: no PyTorch and no model download needed."""

from fastapi.testclient import TestClient

from app import MODEL_NAME, create_app


def word_overlap_scorer():
    def score(query: str, passages: list[str]) -> list[float]:
        words = set(query.lower().split())
        return [float(len(words & set(p.lower().split()))) for p in passages]

    return score


def client() -> TestClient:
    return TestClient(create_app(scorer_factory=word_overlap_scorer))


def test_returns_one_score_per_passage_in_input_order():
    with client() as c:
        res = c.post("/rerank", json={"query": "green frogs", "passages": ["tax forms", "green frogs sing", "frogs"]})

    assert res.status_code == 200
    assert res.json() == {"model": MODEL_NAME, "scores": [0.0, 2.0, 1.0]}


def test_empty_passage_list_returns_no_scores():
    with client() as c:
        res = c.post("/rerank", json={"query": "anything", "passages": []})

    assert res.status_code == 200
    assert res.json()["scores"] == []


def test_rejects_an_empty_query():
    with client() as c:
        assert c.post("/rerank", json={"query": "", "passages": ["x"]}).status_code == 422


def test_rejects_too_many_passages():
    with client() as c:
        assert c.post("/rerank", json={"query": "q", "passages": ["x"] * 201}).status_code == 422


def test_health():
    with client() as c:
        assert c.get("/health").json() == {"status": "ok", "model": MODEL_NAME}
