"""Facts about the run: commit, hardware, Docker, and starting the Compose stack with eval settings."""

import json
import os
import platform
import shutil
import subprocess
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _run(args: list[str], **kwargs) -> str:
    try:
        return subprocess.run(args, cwd=REPO, capture_output=True, text=True, timeout=60, check=True, **kwargs).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def git_info() -> dict:
    status = _run(["git", "status", "--porcelain"])
    return {
        "commit": _run(["git", "rev-parse", "HEAD"]),
        "dirty": bool(status),
        # Tree hashes change whenever code under these folders changes, so a settings fingerprint
        # built from them notices any backend or reranker change.
        "backend_tree": _run(["git", "rev-parse", "HEAD:backend"]),
        "reranker_tree": _run(["git", "rev-parse", "HEAD:sidecars/reranker"]),
    }


def hardware() -> dict:
    info = {"os": f"{platform.system()} {platform.release()}", "machine": platform.machine(),
            "logical_cpus": os.cpu_count(), "cpu": platform.processor()}
    if platform.system() == "Windows":
        cpu = _run(["powershell", "-NoProfile", "-Command",
                    "(Get-CimInstance Win32_Processor | Select-Object -First 1).Name"])
        ram = _run(["powershell", "-NoProfile", "-Command",
                    "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"])
        info["cpu"] = cpu or info["cpu"]
        if ram.isdigit():
            info["ram_gib"] = round(int(ram) / 2**30, 1)
    elif Path("/proc/cpuinfo").exists():
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                info["cpu"] = line.split(":", 1)[1].strip()
                break
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal"):
                info["ram_gib"] = round(int(line.split()[1]) / 2**20, 1)
    docker = _run(["docker", "info", "--format", "{{json .}}"])
    if docker:
        d = json.loads(docker)
        info["docker"] = {"cpus": d.get("NCPU"), "memory_gib": round(d.get("MemTotal", 0) / 2**30, 1),
                          "os": d.get("OperatingSystem"), "server_version": d.get("ServerVersion")}
    info["gpu_used"] = False  # Ollama runs CPU-only in the Compose stack
    return info


def compose(args: list[str], env_overrides: dict[str, str]):
    """Runs docker compose with variables that override .env (Compose gives the shell environment priority)."""
    if not shutil.which("docker"):
        raise RuntimeError("docker is not on PATH")
    env = {**os.environ, **env_overrides}
    subprocess.run(["docker", "compose", *args], cwd=REPO, env=env, check=True)


def start_stack(chunk_tokens: int, chunk_overlap: int, rerank: bool, build: bool = True):
    """Starts db, Ollama, backend (and the reranker) with the given chunk settings.

    Changing the chunk settings recreates the backend container; documents indexed earlier keep
    their chunks, which is why each run uses a fresh eval user.
    """
    env = {"CHUNK_MAX_TOKENS": str(chunk_tokens), "CHUNK_OVERLAP_TOKENS": str(chunk_overlap),
           "RERANK_ENABLED": "true" if rerank else "false"}
    # No --wait: the one-off ollama-pull container exits by design. The harness polls the backend instead.
    args = (["--profile", "rerank"] if rerank else []) + ["up", "-d"]
    if build:
        args.append("--build")
    services = ["db", "ollama", "backend"] + (["reranker"] if rerank else [])
    started = time.monotonic()
    compose(args + services, env)
    return time.monotonic() - started
