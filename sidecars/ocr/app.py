"""OCR for scanned PDFs in SMOI Brain.

POST /ocr  (body: the PDF bytes, Content-Type application/pdf)  ->  {"engine": "...", "pages": ["...", ...]}

Each page is rendered to an image with pdfium, then Tesseract reads the text. `pages[0]` is page
1. Paragraphs within a page are separated by blank lines, which is how the backend splits them.
Runs on CPU; expect roughly a second or more per page.
"""

from __future__ import annotations

import os
from typing import Callable

from fastapi import FastAPI, HTTPException, Request

LANGUAGE = os.environ.get("OCR_LANGUAGE", "eng")
RENDER_DPI = int(os.environ.get("OCR_DPI", "300"))
MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "500"))
MAX_BYTES = 25 * 1024 * 1024  # the backend's upload limit

Recogniser = Callable[[bytes], list[str]]


def tesseract_recogniser(pdf: bytes) -> list[str]:
    # Imported here so the API tests run without pdfium or Tesseract installed.
    import pypdfium2 as pdfium
    import pytesseract

    document = pdfium.PdfDocument(pdf)
    try:
        if len(document) > MAX_PAGES:
            raise ValueError(f"The PDF has {len(document)} pages; the limit is {MAX_PAGES}")
        pages = []
        for page in document:
            image = page.render(scale=RENDER_DPI / 72).to_pil()
            pages.append(pytesseract.image_to_string(image, lang=LANGUAGE))
        return pages
    finally:
        document.close()


def engine_name() -> str:
    try:
        import pytesseract
        return f"tesseract {pytesseract.get_tesseract_version()} ({LANGUAGE})"
    except Exception:  # noqa: BLE001 - only used for a label
        return "tesseract"


def create_app(recogniser: Recogniser = tesseract_recogniser, engine: Callable[[], str] = engine_name) -> FastAPI:
    app = FastAPI(title="SMOI OCR")

    @app.post("/ocr")
    async def ocr(request: Request):
        pdf = await request.body()
        if not pdf:
            raise HTTPException(status_code=400, detail="Send the PDF bytes as the request body")
        if len(pdf) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="The PDF is larger than 25 MB")
        if not pdf.startswith(b"%PDF"):
            raise HTTPException(status_code=415, detail="The body is not a PDF")
        try:
            pages = recogniser(pdf)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        return {"engine": engine(), "pages": pages}

    @app.get("/health")
    def health():
        return {"status": "ok"}

    return app


app = create_app()
