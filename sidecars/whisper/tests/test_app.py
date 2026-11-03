"""API tests with a fake transcriber: no model download needed."""

from fastapi.testclient import TestClient

from app import MAX_AUDIO_BYTES, MODEL_NAME, create_app


def fake_transcriber():
    def transcribe(audio: bytes):
        if audio.startswith(b"garbage"):
            raise ValueError("cannot decode")
        return f"heard {len(audio)} bytes", "en", 1.234

    return transcribe


def client() -> TestClient:
    return TestClient(create_app(transcriber_factory=fake_transcriber))


def test_transcribes_the_request_body():
    with client() as c:
        res = c.post("/transcribe", content=b"RIFF....WAVE", headers={"Content-Type": "audio/wav"})

    assert res.status_code == 200
    assert res.json() == {"model": MODEL_NAME, "text": "heard 12 bytes", "language": "en", "durationSeconds": 1.23}


def test_rejects_an_empty_body():
    with client() as c:
        assert c.post("/transcribe", content=b"").status_code == 400


def test_rejects_audio_that_is_too_long():
    with client() as c:
        assert c.post("/transcribe", content=b"x" * (MAX_AUDIO_BYTES + 1)).status_code == 413


def test_health():
    with client() as c:
        assert c.get("/health").json() == {"status": "ok", "model": MODEL_NAME}
