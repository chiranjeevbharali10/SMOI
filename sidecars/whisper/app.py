"""Local speech-to-text for SMOI's voice commands (FR-03.03).

POST /transcribe  (body: the audio file, for example a 16 kHz mono WAV)
  ->  {"model": "...", "text": "...", "language": "en", "durationSeconds": 3.2}

Runs faster-whisper (a CTranslate2 build of OpenAI's Whisper) on the CPU, so audio never leaves
the machine (NFR-04). The audio is decoded from memory and never written to disk or logged.
"""

from __future__ import annotations

import io
import os
from contextlib import asynccontextmanager
from typing import Callable

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "Systran/faster-whisper-base.en")
# Pinned model revision (a Hugging Face commit), so a re-download can't silently change results.
MODEL_REVISION = os.environ.get("WHISPER_MODEL_REVISION", "3d3d5dee26484f91867d81cb899cfcf72b96be6c")
# A voice command is a sentence or two. 60 s of 16 kHz 16-bit mono WAV is about 1.9 MB.
MAX_AUDIO_BYTES = 4 * 1024 * 1024


class Transcript(BaseModel):
    model: str
    text: str
    language: str
    durationSeconds: float


Transcriber = Callable[[bytes], tuple[str, str, float]]


def model_path() -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(MODEL_NAME, revision=MODEL_REVISION)


def load_whisper() -> Transcriber:
    # Imported here so the API tests can run with a fake transcriber and no model.
    from faster_whisper import WhisperModel

    model = WhisperModel(model_path(), device="cpu", compute_type="int8")

    def transcribe(audio: bytes) -> tuple[str, str, float]:
        # vad_filter drops silence at the start and end, which is most of a short command.
        segments, info = model.transcribe(io.BytesIO(audio), beam_size=5, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
        return text, info.language, float(info.duration)

    return transcribe


def create_app(transcriber_factory: Callable[[], Transcriber] = load_whisper) -> FastAPI:
    state: dict[str, Transcriber] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        state["transcribe"] = transcriber_factory()  # load once at startup
        yield

    app = FastAPI(title="SMOI speech-to-text", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "model": MODEL_NAME}

    @app.post("/transcribe", response_model=Transcript)
    async def transcribe(request: Request) -> Transcript:
        audio = bytearray()
        async for part in request.stream():
            audio.extend(part)
            if len(audio) > MAX_AUDIO_BYTES:
                raise HTTPException(status_code=413, detail="The recording is too long.")
        if not audio:
            raise HTTPException(status_code=400, detail="No audio was sent.")
        try:
            text, language, duration = await _run(state["transcribe"], bytes(audio))
        except ValueError as e:
            raise HTTPException(status_code=400, detail="The audio couldn't be decoded.") from e
        return Transcript(model=MODEL_NAME, text=text, language=language, durationSeconds=round(duration, 2))

    return app


async def _run(fn: Transcriber, audio: bytes) -> tuple[str, str, float]:
    # The model call is CPU-bound; run it in a worker thread so the event loop stays free.
    from starlette.concurrency import run_in_threadpool

    try:
        return await run_in_threadpool(fn, audio)
    except Exception as e:  # PyAV raises its own error types for undecodable input
        if type(e).__module__.startswith("av"):
            raise ValueError(str(e)) from e
        raise


app = create_app()
