# Speech-to-text sidecar

A FastAPI service that turns a short voice command into text with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) and the `Systran/faster-whisper-base.en`
model (MIT, pinned revision, about 145 MB). It runs on the CPU, so audio never leaves the machine.
The backend calls it behind the `SpeechToText` interface (`smoi.stt.provider=whisper`); the desktop
never talks to it directly.

- Audio is decoded from memory. It is never written to disk or logged, by the sidecar or the backend.
- Known limitation: `base.en` is English-only. Set `WHISPER_MODEL` (and its revision) to a
  multilingual model such as `Systran/faster-whisper-base` for other languages.

Run with Docker Compose: `docker compose --profile voice up -d whisper` and set `STT_PROVIDER=whisper`
in `.env`.

API tests (fake transcriber, no model needed):

```sh
cd sidecars/whisper
python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # .venv/bin/pip on Linux/macOS
.venv/Scripts/python -m pytest
```
