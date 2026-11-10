"""Downloadable Piper voices for local pronunciation.

A voice is two files -- a ~63 MB ONNX model and a small JSON config -- published
under MIT in ``rhasspy/piper-voices``. They are fetched on demand into
``<gilzacode home>/voices/<key>/`` and never bundled: shipping 177 voices would
be absurd, and shipping one would pick a language for the user.

The catalog is the upstream ``voices.json``, cached on disk after the first
fetch so the picker still lists what is installed when the machine is offline.
Every file carries an md5 digest upstream, and a download that does not match is
discarded -- a truncated 63 MB model otherwise surfaces much later as an opaque
ONNX parse error, which reads like a bug in the feature rather than a bad
download.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from gilzacode.paths import gilzacode_home

_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/"
_CATALOG_URL = _BASE_URL + "voices.json"

# The catalog changes when voices are added upstream, which is rare. A day keeps
# it current without a network round trip every time the settings panel opens.
_CATALOG_TTL_SECONDS = 24 * 60 * 60

# A voice key names a directory, so it is validated rather than trusted: it
# arrives from the client, and "../.." must not reach the filesystem.
_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")

_DOWNLOAD_TIMEOUT = 600
_USER_AGENT = "GilzaCode"


class VoiceStoreError(RuntimeError):
    """Raised when a voice cannot be listed, downloaded or removed."""

    def __init__(self, message: str, kind: str = "unknown") -> None:
        super().__init__(message)
        self.kind = kind


# In-flight and recently finished downloads, keyed by voice. The download runs
# in a worker thread (a 63 MB read must not sit on the server's event loop), so
# the UI polls this instead of holding a request open for the whole transfer.
_progress: dict[str, dict[str, Any]] = {}
_progress_lock = threading.Lock()


def _set_progress(key: str, **fields: Any) -> None:
    with _progress_lock:
        entry = _progress.setdefault(key, {"key": key})
        entry.update(fields)


def download_progress() -> dict[str, dict[str, Any]]:
    """Return a snapshot of download state, keyed by voice."""
    with _progress_lock:
        return {key: dict(value) for key, value in _progress.items()}


def clear_download_progress(key: str) -> None:
    with _progress_lock:
        _progress.pop(str(key or ""), None)


def is_downloading(key: str) -> bool:
    with _progress_lock:
        return _progress.get(str(key or ""), {}).get("state") == "downloading"


def voices_dir() -> Path:
    return gilzacode_home() / "voices"


def _catalog_path() -> Path:
    return voices_dir() / "catalog.json"


def is_valid_key(key: Any) -> bool:
    return bool(_KEY_RE.match(str(key or "")))


def _require_key(key: Any) -> str:
    name = str(key or "").strip()
    if not is_valid_key(name):
        raise VoiceStoreError(f"'{name}' is not a valid voice name.", kind="bad_request")
    return name


# ─── Catalog ─────────────────────────────────────────────────────────────────

def _fetch_catalog() -> dict[str, Any]:
    request = urllib.request.Request(_CATALOG_URL, headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise VoiceStoreError(
            f"The voice catalog could not be downloaded: {exc}", kind="connection"
        ) from exc
    except ValueError as exc:
        raise VoiceStoreError(
            f"The voice catalog could not be parsed: {exc}", kind="unknown"
        ) from exc


def load_catalog(refresh: bool = False) -> dict[str, Any]:
    """Return the upstream voice catalog, from disk cache when it is fresh.

    A stale cache is preferred over a failure: being offline should not empty
    the list of voices the user can already see installed.
    """
    path = _catalog_path()
    cached: dict[str, Any] | None = None
    if path.is_file():
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cached = None

    fresh_enough = False
    if cached is not None and not refresh:
        try:
            fresh_enough = (time.time() - path.stat().st_mtime) < _CATALOG_TTL_SECONDS
        except OSError:
            fresh_enough = False
    if cached is not None and fresh_enough:
        return cached

    try:
        catalog = _fetch_catalog()
    except VoiceStoreError:
        if cached is not None:
            return cached
        raise

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(catalog), encoding="utf-8")
    except OSError:
        # An uncacheable catalog is still a usable one.
        pass
    return catalog


def _entry_summary(key: str, entry: dict[str, Any]) -> dict[str, Any]:
    language = entry.get("language") or {}
    size = sum(
        int(meta.get("size_bytes") or 0)
        for name, meta in (entry.get("files") or {}).items()
        if name.endswith((".onnx", ".onnx.json"))
    )
    return {
        "key": key,
        "name": entry.get("name", ""),
        "quality": entry.get("quality", ""),
        "num_speakers": int(entry.get("num_speakers") or 1),
        "language_code": language.get("code", ""),
        "language_name": language.get("name_english", ""),
        "language_native": language.get("name_native", ""),
        "country": language.get("country_english", ""),
        "size_bytes": size,
    }


def list_catalog(refresh: bool = False) -> list[dict[str, Any]]:
    """Return every downloadable voice as a UI-ready summary."""
    catalog = load_catalog(refresh=refresh)
    out = [
        _entry_summary(key, entry)
        for key, entry in catalog.items()
        if isinstance(entry, dict)
    ]
    out.sort(key=lambda v: (v["language_code"], v["quality"], v["name"]))
    return out


# ─── Installed voices ────────────────────────────────────────────────────────

def voice_path(key: str) -> Path:
    """Return the path the voice's ``.onnx`` file has, installed or not."""
    name = _require_key(key)
    return voices_dir() / name / f"{name}.onnx"


def is_installed(key: str) -> bool:
    try:
        model = voice_path(key)
    except VoiceStoreError:
        return False
    return model.is_file() and model.with_name(model.name + ".json").is_file()


def installed_voices() -> list[str]:
    """Return the keys of every fully installed voice."""
    root = voices_dir()
    if not root.is_dir():
        return []
    found = []
    for child in root.iterdir():
        if child.is_dir() and is_installed(child.name):
            found.append(child.name)
    return sorted(found)


def remove_voice(key: str) -> None:
    """Delete an installed voice and free its loaded session."""
    name = _require_key(key)
    target = voices_dir() / name
    if not target.is_dir():
        raise VoiceStoreError(f"The voice '{name}' is not installed.", kind="not_found")

    # A cached session holds the file open on Windows, and would keep serving a
    # voice the user just deleted everywhere else.
    try:
        from gilzacode.speech.local_onnx import clear_cache

        clear_cache()
    except Exception:
        pass

    shutil.rmtree(target)


# ─── Download ────────────────────────────────────────────────────────────────

def _download_file(url: str, target: Path, expected_md5: str, expected_size: int,
                   progress: Callable[[int, int], None] | None, done: int, total: int) -> int:
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    digest = hashlib.md5()
    # Written beside the final name and renamed only once it verifies, so an
    # interrupted download never looks like an installed voice.
    temp = target.with_suffix(target.suffix + ".part")
    try:
        with urllib.request.urlopen(request, timeout=_DOWNLOAD_TIMEOUT) as response, \
                open(temp, "wb") as handle:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                handle.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                if progress:
                    progress(done, total)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        temp.unlink(missing_ok=True)
        raise VoiceStoreError(
            f"'{target.name}' could not be downloaded: {exc}", kind="connection"
        ) from exc

    if expected_md5 and digest.hexdigest() != expected_md5:
        temp.unlink(missing_ok=True)
        raise VoiceStoreError(
            f"'{target.name}' arrived corrupted (checksum mismatch) and was discarded.",
            kind="corrupt",
        )
    if expected_size and temp.stat().st_size != expected_size:
        temp.unlink(missing_ok=True)
        raise VoiceStoreError(
            f"'{target.name}' arrived incomplete and was discarded.", kind="corrupt"
        )

    os.replace(temp, target)
    return done


def download_voice(key: str, progress: Callable[[int, int], None] | None = None) -> dict[str, Any]:
    """Download *key* into the voice store and return its summary.

    ``progress`` receives ``(bytes_done, bytes_total)``. Re-downloading an
    installed voice is allowed and replaces it.
    """
    name = _require_key(key)
    catalog = load_catalog()
    entry = catalog.get(name)
    if not isinstance(entry, dict):
        raise VoiceStoreError(f"There is no voice named '{name}'.", kind="not_found")

    wanted = {
        path: meta
        for path, meta in (entry.get("files") or {}).items()
        if path.endswith((".onnx", ".onnx.json"))
    }
    if not wanted:
        raise VoiceStoreError(
            f"The catalog entry for '{name}' lists no model files.", kind="unknown"
        )

    target_dir = voices_dir() / name
    target_dir.mkdir(parents=True, exist_ok=True)

    total = sum(int(meta.get("size_bytes") or 0) for meta in wanted.values())
    done = 0

    def report(bytes_done: int, bytes_total: int) -> None:
        _set_progress(name, state="downloading", done=bytes_done, total=bytes_total, error="")
        if progress:
            progress(bytes_done, bytes_total)

    report(0, total)
    try:
        # Largest first so the progress bar is dominated by the real work.
        for path, meta in sorted(wanted.items(), key=lambda kv: -int(kv[1].get("size_bytes") or 0)):
            done = _download_file(
                _BASE_URL + path,
                target_dir / Path(path).name,
                str(meta.get("md5_digest") or ""),
                int(meta.get("size_bytes") or 0),
                report,
                done,
                total,
            )
    except VoiceStoreError as exc:
        # A half-installed voice is worse than none: it would be listed as
        # available and fail at synthesis time.
        if not is_installed(name):
            shutil.rmtree(target_dir, ignore_errors=True)
        _set_progress(name, state="error", done=done, total=total, error=str(exc))
        raise

    _set_progress(name, state="done", done=total, total=total, error="")
    return _entry_summary(name, entry)
