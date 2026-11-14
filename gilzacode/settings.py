"""Global interface settings, kept in ``<gilzacode home>/settings.json``.

Nothing that must survive a restart lives in the window's localStorage: the
server takes the first free port, the page origin carries that port, and a
launch on another port sees a different localStorage. The interface's own
preferences are therefore string key/value pairs stored here
(``client_prefs``), with localStorage's semantics (GilzaBots §2.1).
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from gilzacode import model_provider
from gilzacode.paths import gilzacode_home, write_text_atomic

DEFAULTS: dict[str, Any] = {
    "lang": "",
    "ui_scale": 1.0,
    "show_hidden_workspace_files": False,
    "last_active_project": "",
    "client_prefs": {},
    "model_provider": dict(model_provider.DEFAULTS),
}

UI_SCALE_MIN = 0.8
UI_SCALE_MAX = 2.0

CLIENT_PREF_KEY_MAX_CHARS = 200
CLIENT_PREF_VALUE_MAX_CHARS = 1_000_000

#: Hidden from the project tree unless the user asks to see hidden files.
DEFAULT_HIDDEN_FILE_EXTENSIONS = (
    ".aux", ".log", ".out", ".toc", ".synctex.gz", ".fls", ".fdb_latexmk",
    ".bbl", ".blg", ".nav", ".snm", ".vrb", ".xdv", ".lof", ".lot",
)

# Settings are read-modify-written from request handlers running in threads.
_lock = threading.RLock()


def settings_path() -> Path:
    return gilzacode_home() / "settings.json"


def load() -> dict[str, Any]:
    """The stored settings over the defaults; a corrupt file reads as the defaults."""
    result = json.loads(json.dumps(DEFAULTS))
    path = settings_path()
    try:
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                result.update(raw)
    except (OSError, ValueError):
        pass
    return result


def save(changes: dict[str, Any]) -> dict[str, Any]:
    """Merge `changes` into the stored settings and return the result."""
    with _lock:
        current = load()
        current.update(changes)
        write_text_atomic(settings_path(), json.dumps(current, indent=2, ensure_ascii=False))
        return current


def clamp_ui_scale(value: Any) -> float:
    """A valid interface scale; anything non-numeric is 1.0."""
    try:
        scale = float(value)
    except (TypeError, ValueError):
        return 1.0
    if scale != scale or scale in (float("inf"), float("-inf")):
        return 1.0
    return max(UI_SCALE_MIN, min(UI_SCALE_MAX, scale))


def hidden_file_extensions() -> list[str]:
    return list(DEFAULT_HIDDEN_FILE_EXTENSIONS)


def _validate_pref_changes(changes: Any, removals: Any) -> tuple[dict[str, str], list[str]]:
    if not isinstance(changes, dict):
        raise ValueError("'set' must be an object of string keys to string values")
    if not isinstance(removals, list):
        raise ValueError("'remove' must be a list of keys")
    for key in list(changes) + removals:
        if not isinstance(key, str) or not key or len(key) > CLIENT_PREF_KEY_MAX_CHARS:
            raise ValueError(
                f"preference keys must be non-empty strings of at most {CLIENT_PREF_KEY_MAX_CHARS} characters"
            )
    for key, value in changes.items():
        if not isinstance(value, str):
            raise ValueError(f"the value of preference {key!r} must be a string")
        if len(value) > CLIENT_PREF_VALUE_MAX_CHARS:
            raise ValueError(f"the value of preference {key!r} exceeds {CLIENT_PREF_VALUE_MAX_CHARS} characters")
    return changes, removals


#: Old localStorage keys that the one-time import does not copy into client_prefs.
_LEGACY_KEYS_NOT_IMPORTED = {"lastActiveProject", "uiLanguage"}


def load_client_prefs() -> dict[str, Any]:
    """The stored preferences and whether the one-time localStorage import ran."""
    current = load()
    prefs = current.get("client_prefs")
    return {"prefs": dict(prefs) if isinstance(prefs, dict) else {},
            "imported": bool(current.get("client_prefs_imported", False))}


def update_client_prefs(changes: Any, removals: Any = None, *, legacy_import: bool = False) -> bool:
    """Apply preference changes; return whether they were applied.

    Raises ValueError for a malformed request. ``legacy_import`` is the one-time
    copy of a window's old localStorage (GilzaBots §2.1): it is applied only while
    no import has happened yet and never overwrites a key already stored, so a
    window on another port cannot bring back an older copy.
    """
    changes, removals = _validate_pref_changes(changes, [] if removals is None else removals)
    with _lock:
        current = load()
        prefs = current.get("client_prefs")
        prefs = dict(prefs) if isinstance(prefs, dict) else {}
        update: dict[str, Any] = {}
        if legacy_import:
            if current.get("client_prefs_imported"):
                return False
            last_project = changes.get("lastActiveProject", "")
            if last_project.strip() and not current.get("last_active_project"):
                update["last_active_project"] = last_project
            for key, value in changes.items():
                if key not in _LEGACY_KEYS_NOT_IMPORTED:
                    prefs.setdefault(key, value)
            update["client_prefs_imported"] = True
        else:
            prefs.update(changes)
            for key in removals:
                prefs.pop(key, None)
        update["client_prefs"] = prefs
        save(update)
        return True
