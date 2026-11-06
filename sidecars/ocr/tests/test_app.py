"""API tests with a fake recogniser: no pdfium or Tesseract needed."""

from fastapi.testclient import TestClient

from app import create_app


def fake_recogniser(pdf: bytes) -> list[str]:
    if b"too-many-pages" in pdf:
        raise ValueError("The PDF has 900 pages; the limit is 500")
    return ["Page one text.\n\nSecond paragraph.", ""]


def client() -> TestClient:
    return TestClient(create_app(recogniser=fake_recogniser, engine=lambda: "fake"))


def test_returns_one_string_per_page_in_order():
    res = client().post("/ocr", content=b"%PDF-1.7 fake", headers={"Content-Type": "application/pdf"})

    assert res.status_code == 200
    assert res.json() == {"engine": "fake", "pages": ["Page one text.\n\nSecond paragraph.", ""]}


def test_rejects_an_empty_body():
    assert client().post("/ocr", content=b"").status_code == 400


def test_rejects_something_that_is_not_a_pdf():
    assert client().post("/ocr", content=b"PK\x03\x04 a zip").status_code == 415


def test_reports_a_page_limit_as_unprocessable():
    res = client().post("/ocr", content=b"%PDF too-many-pages")

    assert res.status_code == 422
    assert "limit" in res.json()["detail"]
