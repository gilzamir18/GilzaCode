"""Where GilzaCode keeps its global data, and checks that a folder is usable."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

#: Folders already proven writable in this process.
_verified_dirs: set[str] = set()


def gilzacode_home() -> Path:
    """The global data directory: ``GILZACODE_HOME`` or ``~/.gilzacode``.

    Read on every call, so tests (and a restart after a change) see the current value.
    """
    configured = os.environ.get("GILZACODE_HOME", "").strip()
    return Path(os.path.expanduser(configured)) if configured else Path.home() / ".gilzacode"


def writable_dir_problem(path: str) -> str:
    """Why `path` cannot hold files, or ``""`` when it can.

    Probes by creating a file: ``os.access`` misses ACL denials on Windows.
    The directory is created when missing.
    """
    if not path:
        return "the path is empty"
    if path in _verified_dirs:
        return ""
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as exc:
        return f"the directory could not be created ({exc.strerror or exc})"
    if not os.path.isdir(path):
        return "the path is not a directory"
    try:
        with tempfile.NamedTemporaryFile(dir=path, prefix=".gilzacode-probe-"):
            pass
    except OSError as exc:
        return f"the directory is not writable ({exc.strerror or exc})"
    _verified_dirs.add(path)
    return ""


def write_text_atomic(path: Path, text: str) -> None:
    """Write `text` to `path` through a temporary file and ``os.replace``.

    A crash mid-write leaves the previous content, never a truncated file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
