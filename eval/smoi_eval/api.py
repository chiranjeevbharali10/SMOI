"""A small client for the SMOI backend's HTTP API (standard library only).

The evaluation drives the real backend over HTTP, the same way the desktop app will, so it measures
the system as deployed: auth, ingestion, retrieval SQL, prompts and citation checks.
"""

import json
import mimetypes
import secrets
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


class ApiError(Exception):
    def __init__(self, status: int, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.body = body


class SmoiClient:
    def __init__(self, base_url: str, timeout: float = 300):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.token: str | None = None

    # ---------- plumbing ----------

    def _request(self, method: str, path: str, body: bytes | None = None, content_type: str | None = None,
                 ok_statuses=(200, 201, 202, 204)):
        headers = {"Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(self.base_url + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        parsed = json.loads(raw) if raw else None
        if status not in ok_statuses:
            raise ApiError(status, parsed)
        return status, parsed

    def _json(self, method: str, path: str, payload=None, ok_statuses=(200, 201, 202, 204)):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        return self._request(method, path, body, "application/json" if body else None, ok_statuses)

    # ---------- endpoints ----------

    def wait_until_up(self, timeout_s: float = 300):
        """Waits for the backend to answer. Any HTTP response (even 401) means it is up."""
        deadline = time.monotonic() + timeout_s
        while True:
            try:
                urllib.request.urlopen(self.base_url + "/actuator/health", timeout=5)
                return
            except urllib.error.HTTPError:
                return
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                if time.monotonic() > deadline:
                    raise TimeoutError(f"Backend at {self.base_url} did not respond within {timeout_s:.0f} s")
                time.sleep(2)

    def register_and_login(self, label: str = "eval") -> str:
        """Creates a fresh user, so each run starts with an empty document set. Returns the email."""
        email = f"{label}-{uuid.uuid4().hex[:12]}@example.com"
        password = secrets.token_urlsafe(24)
        self._json("POST", "/api/auth/register", {"email": email, "password": password})
        _, body = self._json("POST", "/api/auth/login", {"email": email, "password": password})
        self.token = body["accessToken"]
        return email

    def providers(self) -> dict:
        return self._json("GET", "/api/settings/providers")[1]

    def upload(self, path: Path) -> dict:
        boundary = uuid.uuid4().hex
        media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        body = b"".join([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'.encode(),
            f"Content-Type: {media_type}\r\n\r\n".encode(),
            path.read_bytes(),
            f"\r\n--{boundary}--\r\n".encode(),
        ])
        return self._request("POST", "/api/documents", body, f"multipart/form-data; boundary={boundary}")[1]

    def document(self, document_id: str) -> dict:
        return self._json("GET", f"/api/documents/{document_id}")[1]

    def chunks(self, document_id: str) -> list[dict]:
        return self._json("GET", f"/api/documents/{document_id}/chunks")[1]

    def delete_document(self, document_id: str):
        self._json("DELETE", f"/api/documents/{document_id}")

    def search(self, query: str, mode: str, top_k: int) -> dict:
        return self._json("POST", "/api/search", {"query": query, "mode": mode, "topK": top_k})[1]

    def query(self, question: str, mode: str, top_k: int | None = None) -> tuple[int, dict]:
        """Returns (status, body). A rejected answer is HTTP 502 with outcome citation_rejected; that
        is a result to count, not an error."""
        payload = {"question": question, "mode": mode}
        if top_k:
            payload["topK"] = top_k
        return self._json("POST", "/api/query", payload, ok_statuses=(200, 502))
