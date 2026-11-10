"""Per-project cloud settings and the sync baseline, stored inside the project.

Everything here lives at ``<project>/.gilzacode/cloud/state.json`` and is
**machine-local**: it records this computer's view of what was last synced
(content hashes and remote revisions) plus the user's choices for this project.
It is deliberately excluded from the sync set — uploading it would make two
machines fight over each other's baseline.

The baseline is what makes a real three-way sync possible. Without it the engine
could only see "local differs from remote" and would have to guess a winner;
with it, the engine knows *which side* changed since both agreed.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from .atomic import discard_file, replace_file

# Machine-local sync bookkeeping. Kept under `.gilzacode/cloud/` so a single
# exclusion rule covers the whole thing.
CLOUD_DIR = os.path.join(".gilzacode", "cloud")
STATE_FILENAME = "state.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class SyncEntry:
    """The last state at which local and remote were known to agree."""

    hash: str = ""          # sha256 of the local bytes at that moment
    size: int = 0
    mtime: float = 0.0      # local mtime, used only as a "probably unchanged" fast path
    remote_rev: str = ""    # opaque provider revision at that moment
    synced_at: str = ""

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "SyncEntry":
        return cls(
            hash=str(raw.get("hash", "")),
            size=int(raw.get("size", 0) or 0),
            mtime=float(raw.get("mtime", 0.0) or 0.0),
            remote_rev=str(raw.get("remote_rev", "")),
            synced_at=str(raw.get("synced_at", "")),
        )


@dataclass
class CloudSettings:
    """User-facing choices for one project.

    Defaults follow the project owner's instruction to mirror the whole project:
    build artifacts and conversations are included. ``include_dotenv`` is the
    one deliberate exception — see the field comment.
    """

    enabled: bool = False
    provider: str = ""
    # Folder name created in the provider's account. Empty means "derive from
    # the project name".
    remote_folder: str = ""
    # LaTeX build output (.aux, .log, .synctex.gz, .pdf, ...). Included so the
    # mirror is a faithful copy of the working directory.
    include_build_artifacts: bool = True
    # `.env` holds provider API keys. Uploading it would copy those credentials
    # into cloud storage, so it stays out unless the user opts in explicitly.
    include_dotenv: bool = False
    # Sync automatically after local edits, instead of only on demand.
    auto_sync: bool = True
    # Idle time before an automatic sync fires. Typing produces a burst of
    # writes; syncing each one would waste the provider's rate limit.
    debounce_seconds: int = 15
    # How often to poll the remote for changes made on another machine.
    poll_seconds: int = 300
    # Extra glob patterns to skip, matched against project-relative paths.
    extra_excludes: list[str] = field(default_factory=list)
    # Non-secret, backend-specific settings (the local-folder provider's base
    # directory, for instance). Credentials never live here: they belong to the
    # provider's own private store outside the project.
    provider_config: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "CloudSettings":
        base = cls()
        if not isinstance(raw, dict):
            return base
        excludes = raw.get("extra_excludes")
        return cls(
            enabled=bool(raw.get("enabled", base.enabled)),
            provider=str(raw.get("provider", base.provider) or ""),
            remote_folder=str(raw.get("remote_folder", base.remote_folder) or ""),
            include_build_artifacts=bool(
                raw.get("include_build_artifacts", base.include_build_artifacts)
            ),
            include_dotenv=bool(raw.get("include_dotenv", base.include_dotenv)),
            auto_sync=bool(raw.get("auto_sync", base.auto_sync)),
            debounce_seconds=max(1, int(raw.get("debounce_seconds", base.debounce_seconds) or 1)),
            poll_seconds=max(0, int(raw.get("poll_seconds", base.poll_seconds) or 0)),
            extra_excludes=[str(p) for p in excludes] if isinstance(excludes, list) else [],
            provider_config={
                str(k): str(v) for k, v in (raw.get("provider_config") or {}).items()
            }
            if isinstance(raw.get("provider_config"), dict)
            else {},
        )


@dataclass
class CloudState:
    """Settings plus the sync baseline for one project."""

    settings: CloudSettings = field(default_factory=CloudSettings)
    # Opaque provider handle for the project's remote root folder.
    root: str = ""
    entries: dict[str, SyncEntry] = field(default_factory=dict)
    last_sync_at: str = ""
    last_error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": 1,
            "settings": asdict(self.settings),
            "root": self.root,
            "entries": {path: asdict(entry) for path, entry in sorted(self.entries.items())},
            "last_sync_at": self.last_sync_at,
            "last_error": self.last_error,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "CloudState":
        if not isinstance(raw, dict):
            return cls()
        entries_raw = raw.get("entries")
        entries: dict[str, SyncEntry] = {}
        if isinstance(entries_raw, dict):
            for path, value in entries_raw.items():
                if isinstance(value, dict):
                    entries[str(path)] = SyncEntry.from_dict(value)
        return cls(
            settings=CloudSettings.from_dict(raw.get("settings") or {}),
            root=str(raw.get("root", "") or ""),
            entries=entries,
            last_sync_at=str(raw.get("last_sync_at", "") or ""),
            last_error=str(raw.get("last_error", "") or ""),
        )

    # -- baseline maintenance -------------------------------------------------

    def record(self, rel_path: str, *, hash_: str, size: int, mtime: float, remote_rev: str) -> None:
        self.entries[rel_path] = SyncEntry(
            hash=hash_, size=size, mtime=mtime, remote_rev=remote_rev, synced_at=_now()
        )

    def forget(self, rel_path: str) -> None:
        self.entries.pop(rel_path, None)

    def mark_synced(self, error: str = "") -> None:
        self.last_sync_at = _now()
        self.last_error = error


def state_path(project_path: str) -> str:
    return os.path.join(os.path.abspath(project_path), CLOUD_DIR, STATE_FILENAME)


def load_state(project_path: str) -> CloudState:
    """Read the project's cloud state, returning defaults when absent.

    A corrupt state file degrades to an empty baseline rather than raising: the
    next sync then treats every file as new, which converges (uploading what is
    missing, flagging real divergences as conflicts) instead of leaving the
    project stuck with no way to sync.
    """
    path = state_path(project_path)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return CloudState.from_dict(json.load(handle))
    except FileNotFoundError:
        return CloudState()
    except (json.JSONDecodeError, OSError, ValueError):
        return CloudState()


def save_state(project_path: str, state: CloudState) -> None:
    """Persist the state atomically.

    The baseline is rewritten after every sync pass, including passes that are
    interrupted. A half-written state.json would make the next run mistake
    already-synced files for new ones, so the write goes through a temp file in
    the same directory and an atomic replace.
    """
    path = state_path(project_path)
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    payload = json.dumps(state.to_dict(), indent=2, ensure_ascii=False)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory, prefix=".state-", suffix=".tmp", delete=False
    )
    try:
        with handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        replace_file(handle.name, path)
    except BaseException:
        try:
            discard_file(handle.name)
        except OSError:
            pass
        raise


def load_settings(project_path: str) -> CloudSettings:
    return load_state(project_path).settings


def save_settings(project_path: str, settings: CloudSettings) -> CloudState:
    """Update only the settings section, preserving the sync baseline."""
    state = load_state(project_path)
    previous = state.settings
    state.settings = settings
    # Switching provider invalidates the baseline: remote revisions and the root
    # handle belong to the old backend and mean nothing to the new one. Dropping
    # them makes the next sync re-reconcile from scratch instead of comparing
    # against revisions that can never match.
    if previous.provider and previous.provider != settings.provider:
        state.root = ""
        state.entries = {}
    save_state(project_path, state)
    return state


def reset_baseline(project_path: str) -> CloudState:
    """Drop the baseline but keep settings, forcing a full re-reconciliation."""
    state = load_state(project_path)
    state.root = ""
    state.entries = {}
    state.last_sync_at = ""
    state.last_error = ""
    save_state(project_path, state)
    return state
