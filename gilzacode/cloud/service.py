"""Orchestration: when a project syncs, and what a sync pass consists of.

The engine reconciles files. This layer decides *when* to run it and keeps one
pass per project at a time. (Ported from GilzaBots without its conversation
export: Claude Code keeps its sessions outside the project.)

Scheduling has three triggers:

* **debounced local trigger** — the file endpoints announce "something changed
  here" and a pass runs once the project has been quiet for `debounce_seconds`.
  Typing produces a burst of writes; syncing each one would spend the provider's
  rate limit to upload a file that changes again a second later.
* **local watch** — Claude Code edits files directly on disk, where no endpoint
  sees it. Every `LOCAL_WATCH_SECONDS` a stat-only walk (size and mtime, no
  reading) compares the project with its previous look and announces a change
  through the same debounced trigger.
* **periodic poll** — picks up edits made on another machine, which nothing
  local can announce.

All provider I/O is blocking, so passes run in a worker thread; the asyncio
server that owns the event loop is never blocked by a network round-trip.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Optional

from .base import (
    CloudAuthError,
    CloudError,
    CloudStorageProvider,
    RemoteProject,
    hash_file,
    local_path_for,
    normalize_rel_path,
)
from .engine import PULL, TWO_WAY, ProgressEvent, SyncEngine, SyncReport
from .registry import get_cloud_provider, list_providers
from .scanner import scan_project
from .state import (
    CloudSettings,
    CloudState,
    load_state,
    save_settings,
    save_state,
)


# How many finished transfers the panel keeps in view. A pass over a large
# project can move thousands of files; the list is there to show what is
# happening now, and the report already carries the complete outcome.
RECENT_LIMIT = 40

# Actions that move data, as opposed to the engine walking past a file that
# needed nothing. Only these are worth listing to the user.
_TRANSFER_ACTIONS = frozenset(
    {"upload", "download", "delete-remote", "delete-local", "conflict"}
)


@dataclass
class SyncProgress:
    """What a pass is doing right now, for the status bar and the panel.

    A pass runs in a worker thread while the request handler reads this from the
    event loop, so every read and write goes through :data:`_PROGRESS_LOCK` and
    hands back copies. The snapshot survives the end of the pass — the panel
    keeps showing what the last pass moved instead of blanking the moment it
    finishes.
    """

    active: bool = False
    dry_run: bool = False
    started_at: float = 0.0
    finished_at: float = 0.0
    phase: str = "idle"  # idle | scanning | transferring | done
    total: int = 0
    examined: int = 0
    current_path: str = ""
    current_action: str = ""
    recent: list[dict[str, str]] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    # Set by :func:`request_cancel`; the engine polls it between files.
    cancel_requested: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "active": self.active,
            "dry_run": self.dry_run,
            "phase": self.phase,
            "total": self.total,
            "examined": self.examined,
            "current_path": self.current_path,
            "current_action": self.current_action,
            "recent": list(self.recent),
            "counts": dict(self.counts),
            "cancel_requested": self.cancel_requested,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


_PROGRESS: dict[str, SyncProgress] = {}
_PROGRESS_LOCK = threading.Lock()


def progress_for(project_path: str) -> dict[str, Any]:
    """The current (or last) pass's progress for one project."""
    with _PROGRESS_LOCK:
        progress = _PROGRESS.get(_key(project_path))
        return progress.to_dict() if progress else SyncProgress().to_dict()


def _begin_progress(project_path: str, dry_run: bool) -> SyncProgress:
    progress = SyncProgress(
        active=True, dry_run=dry_run, started_at=time.time(), phase="scanning"
    )
    with _PROGRESS_LOCK:
        _PROGRESS[_key(project_path)] = progress
    return progress


def request_cancel(project_path: str) -> bool:
    """Ask the pass running for `project_path` to stop at the next file.

    Covers every kind of pass that reports progress — a manual or background
    sync, a preview, a download into a new folder — because they all register
    here under the path they write to. Returns False when nothing is running,
    so the caller can tell "stopping" from "there was nothing to stop".
    """
    with _PROGRESS_LOCK:
        progress = _PROGRESS.get(_key(project_path))
        if progress is None or not progress.active:
            return False
        progress.cancel_requested = True
        return True


def _cancel_check(progress: SyncProgress):
    def should_cancel() -> bool:
        with _PROGRESS_LOCK:
            return progress.cancel_requested
    return should_cancel


def _end_progress(project_path: str) -> None:
    with _PROGRESS_LOCK:
        progress = _PROGRESS.get(_key(project_path))
        if progress is None:
            return
        progress.active = False
        progress.phase = "done"
        progress.finished_at = time.time()
        progress.current_path = ""
        progress.current_action = ""


def _record_progress(progress: SyncProgress, event: ProgressEvent) -> None:
    """Fold one engine event into the shared snapshot."""
    with _PROGRESS_LOCK:
        if event.total:
            progress.total = event.total
        if event.index:
            progress.examined = event.index
        if event.action == "plan":
            progress.phase = "transferring"
            return
        if event.action == "visit":
            # Walking past a file is not worth listing, but it is what keeps the
            # counter moving through a long stretch of unchanged files.
            return
        progress.current_action = event.action
        progress.current_path = event.rel_path
        if event.action in _TRANSFER_ACTIONS:
            progress.counts[event.action] = progress.counts.get(event.action, 0) + 1
            progress.recent.append({"action": event.action, "path": event.rel_path})
            del progress.recent[:-RECENT_LIMIT]


@dataclass
class SyncOutcome:
    """A completed pass, as the UI and the API see it."""

    report: Optional[SyncReport] = None
    error: str = ""
    provider: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": bool(self.report and self.report.ok and not self.error),
            "provider": self.provider,
            "error": self.error,
            "report": self.report.to_dict() if self.report else None,
        }


@dataclass
class _Registration:
    project_name: str
    project_path: str
    # Set when a local change was announced; cleared when a pass starts.
    dirty: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task] = None
    watch_task: Optional[asyncio.Task] = None
    last_outcome: Optional[SyncOutcome] = None
    running: bool = False


#: Seconds between two stat-only looks at a project for edits made outside the
#: app's endpoints (Claude Code writes straight to disk).
LOCAL_WATCH_SECONDS = 10.0


def local_signature(project_path: str, settings: CloudSettings) -> int:
    """A fingerprint of what would be synced: every included path, size and mtime.

    Reads metadata only, with the scan's own exclusions, so a change outside the
    sync set (build directories, the baseline) never triggers a pass.
    """
    from .scanner import PRUNED_DIRS, ExclusionPolicy

    root = os.path.abspath(project_path)
    policy = ExclusionPolicy(settings)
    items = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in PRUNED_DIRS)
        for filename in sorted(filenames):
            absolute = os.path.join(dirpath, filename)
            rel = os.path.relpath(absolute, root).replace(os.sep, "/")
            if not policy.allows(rel):
                continue
            try:
                info = os.stat(absolute)
            except OSError:
                continue
            items.append((rel, info.st_size, info.st_mtime_ns))
    return hash(tuple(items))


def build_provider(settings: CloudSettings) -> CloudStorageProvider:
    return get_cloud_provider(settings.provider, dict(settings.provider_config or {}))


def sync_project(
    project_name: str,
    project_path: str,
    *,
    direction: str = TWO_WAY,
    dry_run: bool = False,
    allow_bulk_delete: bool = False,
    provider: Optional[CloudStorageProvider] = None,
) -> SyncOutcome:
    """Run one complete pass, blocking. Safe to call from a worker thread."""
    state = load_state(project_path)
    settings = state.settings
    if not settings.provider:
        return SyncOutcome(error="No cloud provider is configured for this project.")

    try:
        backend = provider or build_provider(settings)
    except CloudError as exc:
        return SyncOutcome(error=str(exc), provider=settings.provider)

    outcome = SyncOutcome(provider=settings.provider)
    progress = _begin_progress(project_path, dry_run)
    try:
        def persist(current: CloudState) -> None:
            save_state(project_path, current)

        engine = SyncEngine(
            project_path,
            backend,
            state,
            direction=direction,
            persist=persist,
            allow_bulk_delete=allow_bulk_delete,
            on_progress=lambda event: _record_progress(progress, event),
            should_cancel=_cancel_check(progress),
        )
        report = engine.run(dry_run=dry_run)
        outcome.report = report
    except CloudAuthError as exc:
        outcome.error = str(exc)
    except CloudError as exc:
        outcome.error = str(exc)
    finally:
        _end_progress(project_path)
        invalidate_file_states(project_path)
        if provider is None:
            try:
                backend.close()
            except Exception:
                pass
    return outcome


def _rel_path_of(project_path: str, absolute: str) -> str:
    return os.path.relpath(absolute, project_path).replace(os.sep, "/")


# ─── Bringing a project onto a second machine ─────────────────────────────────

@dataclass
class CloneOutcome:
    """The result of pulling a mirrored project down onto this machine."""

    project_path: str = ""
    remote_folder: str = ""
    provider: str = ""
    report: Optional[SyncReport] = None
    error: str = ""
    # The user stopped the download; see `partial_copy_removed`.
    cancelled: bool = False
    partial_copy_removed: bool = False

    @property
    def ok(self) -> bool:
        return bool(self.report and self.report.ok and not self.error)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "cancelled": self.cancelled,
            "partial_copy_removed": self.partial_copy_removed,
            "project_path": self.project_path,
            "remote_folder": self.remote_folder,
            "provider": self.provider,
            "error": self.error,
            "report": self.report.to_dict() if self.report else None,
        }


def list_remote_projects(
    provider_id: str,
    provider_config: Optional[dict[str, Any]] = None,
    *,
    provider: Optional[CloudStorageProvider] = None,
) -> list[RemoteProject]:
    """Enumerate the projects already mirrored in an account. Blocking."""
    backend = provider or get_cloud_provider(provider_id, dict(provider_config or {}))
    try:
        if not backend.capabilities().project_listing:
            raise CloudError(
                f"{backend.display_name or provider_id} cannot list projects."
            )
        return backend.list_projects()
    finally:
        if provider is None:
            try:
                backend.close()
            except Exception:
                pass


def _expand_destination(destination: str) -> str:
    return os.path.abspath(os.path.expanduser(str(destination or "").strip()))


def prepare_destination(destination: str) -> str:
    """Validate where a clone is about to land, and create the directory.

    The destination has to be empty. A clone runs as a one-way pull, and a pull
    into a directory that already holds files would reconcile them against the
    remote — turning "download a copy of my project" into a sync of whatever
    happened to be there. Refusing loudly is the only answer that cannot
    silently merge two unrelated projects.
    """
    expanded = _expand_destination(destination)
    if not expanded or expanded == os.path.abspath(os.sep):
        raise CloudError("A destination folder is required.")
    if os.path.exists(expanded):
        if not os.path.isdir(expanded):
            raise CloudError(f"{expanded} exists and is not a directory.")
        if os.listdir(expanded):
            raise CloudError(
                f"{expanded} is not empty. Choose an empty or new folder for the "
                f"downloaded project."
            )
    os.makedirs(expanded, exist_ok=True)
    if not os.access(expanded, os.W_OK):
        raise CloudError(f"No write access to {expanded}.")
    return expanded


def clone_project(
    provider_id: str,
    remote_name: str,
    destination: str,
    *,
    provider_config: Optional[dict[str, Any]] = None,
    remote_root: str = "",
    settings_overrides: Optional[dict[str, Any]] = None,
    provider: Optional[CloudStorageProvider] = None,
    destination_is_new: Optional[bool] = None,
) -> CloneOutcome:
    """Download a mirrored project into `destination`, blocking.

    This is the second half of the feature the mirror exists for: machine A
    enables sync, machine B downloads the project and carries on. The pass runs
    in the PULL direction — the remote is the only copy that means anything yet,
    and nothing local should be published back before the user has even opened
    it.

    The project's cloud settings are written before the pass because the engine
    reads them (what to exclude, which remote folder), which also means a
    download that fails halfway leaves a folder holding a partial copy plus its
    settings. That folder is not a project yet and is not empty either, so a
    retry has to be pointed at a fresh folder — see the endpoint, which says so.

    Registering the project with the application (``gilzacode/projects.py``) is
    the caller's job — this layer knows about storage, not
    about the project store.

    A download the user cancels (:func:`request_cancel` on the destination) is
    different from one that fails: nobody needs to inspect what arrived, so the
    partial copy is removed. That is safe because the destination was verified
    empty before the first byte, so everything in it came from this clone and
    is still in the cloud. The directory itself is removed only when this clone
    created it — `destination_is_new` says so for a caller that already created
    it while validating; left as None, it is decided here.
    """
    outcome = CloneOutcome(remote_folder=remote_name, provider=provider_id)
    if destination_is_new is None:
        destination_is_new = not os.path.exists(_expand_destination(destination))
    overrides = dict(settings_overrides or {})
    project_path = ""
    backend: Optional[CloudStorageProvider] = None
    progress: Optional[SyncProgress] = None
    try:
        # Everything that can refuse the clone runs before anything is
        # transferred, and reports through the outcome rather than raising, so
        # one caller shape covers "the folder is wrong" and "the network died".
        project_path = prepare_destination(destination)
        outcome.project_path = project_path
        # Registered before anything slow, so a cancel that arrives while the
        # backend is still connecting is not lost.
        progress = _begin_progress(project_path, dry_run=False)
        backend = provider or get_cloud_provider(provider_id, dict(provider_config or {}))

        settings = CloudSettings.from_dict(
            {
                "enabled": True,
                "provider": provider_id,
                "remote_folder": remote_name,
                "provider_config": dict(provider_config or {}),
                **overrides,
            }
        )
        state = CloudState(settings=settings, root=str(remote_root or ""))
        save_state(project_path, state)

        engine = SyncEngine(
            project_path,
            backend,
            state,
            direction=PULL,
            persist=lambda current: save_state(project_path, current),
            on_progress=lambda event: _record_progress(progress, event),
            should_cancel=_cancel_check(progress),
        )
        outcome.report = engine.run()
        if outcome.report.cancelled:
            outcome.cancelled = True
            outcome.partial_copy_removed = _discard_partial_clone(
                project_path, remove_directory=bool(destination_is_new)
            )
            if not outcome.partial_copy_removed:
                outcome.error = (
                    f"Download cancelled, but the partial copy in {project_path} could "
                    f"not be removed. Delete that folder before downloading again."
                )
    except CloudError as exc:
        outcome.error = str(exc)
    except OSError as exc:
        outcome.error = str(exc)
    finally:
        if project_path:
            if progress is not None:
                _end_progress(project_path)
            invalidate_file_states(project_path)
        if provider is None and backend is not None:
            try:
                backend.close()
            except Exception:
                pass
    return outcome


def _discard_partial_clone(project_path: str, *, remove_directory: bool) -> bool:
    """Undo a cancelled clone: empty the destination, and remove it if it is new.

    Only called after `prepare_destination` confirmed the folder was empty when
    the clone began, so nothing removed here predates the clone.
    """
    try:
        for name in os.listdir(project_path):
            absolute = os.path.join(project_path, name)
            if os.path.isdir(absolute) and not os.path.islink(absolute):
                shutil.rmtree(absolute)
            else:
                os.remove(absolute)
        if remove_directory:
            os.rmdir(project_path)
    except OSError:
        return False
    return True


# ─── Deleting a project's cloud copy ──────────────────────────────────────────

def cloud_link(project_path: str) -> dict[str, Any]:
    """Whether this project has a copy in the cloud, without touching the network.

    Asked when the user is about to delete the project, so the dialog can offer
    to delete that copy too. A project has one once a pass has recorded its
    remote folder; enabling sync without ever completing a pass leaves nothing
    to delete.
    """
    state = load_state(project_path)
    settings = state.settings
    link: dict[str, Any] = {
        "linked": bool(settings.provider and state.root),
        "provider": settings.provider,
        "provider_name": "",
        "remote_folder": settings.remote_folder or os.path.basename(os.path.abspath(project_path)),
        "recoverable": False,
    }
    if not link["linked"]:
        return link
    try:
        backend = build_provider(settings)
    except CloudError as exc:
        link["error"] = str(exc)
        return link
    try:
        link["provider_name"] = backend.display_name or settings.provider
        link["recoverable"] = backend.capabilities().recoverable_root_deletion
    finally:
        try:
            backend.close()
        except Exception:
            pass
    return link


def delete_remote_project(
    project_path: str, *, provider: Optional[CloudStorageProvider] = None
) -> dict[str, Any]:
    """Delete the project's folder in the cloud. Blocking.

    Other machines that still mirror the project find the folder gone on their
    next pass and stop there (:class:`CloudRootMissing`) with their own copy
    untouched. Callers should go through :meth:`CloudSyncManager.delete_remote_copy`,
    which first stops any pass running for the project.
    """
    state = load_state(project_path)
    settings = state.settings
    if not (settings.provider and state.root):
        return {"deleted": False, "reason": "This project has no copy in the cloud."}
    backend = provider or build_provider(settings)
    try:
        backend.delete_root(state.root)
    finally:
        if provider is None:
            try:
                backend.close()
            except Exception:
                pass
    remote_folder = settings.remote_folder or os.path.basename(os.path.abspath(project_path))
    # This machine's link to the folder is gone too; left in place, a later
    # pass here would stop on the missing root instead of saying nothing.
    state.root = ""
    state.entries = {}
    save_state(project_path, state)
    return {"deleted": True, "provider": settings.provider, "remote_folder": remote_folder}


KEEP_LOCAL = "keep_local"
KEEP_REMOTE = "keep_remote"
CONFLICT_RESOLUTIONS = (KEEP_LOCAL, KEEP_REMOTE)


def resolve_conflict(
    project_path: str,
    rel_path: str,
    resolution: str,
    *,
    conflict_copy: str = "",
    provider: Optional[CloudStorageProvider] = None,
) -> dict[str, Any]:
    """Settle one conflicted file the way the user chose.

    A conflicted pass keeps the working copy, uploads it, and parks the other
    machine's version beside it as a conflict copy. Nothing is lost, but the
    user is left with two files and no way to say which one wins. This is that
    decision:

    ``keep_local``
        The working copy stays. Since the conflicted pass already sent it, this
        mostly means dropping the copy — the upload is repeated so the outcome
        is the same even if the remote moved since.
    ``keep_remote``
        The conflict copy is promoted over the working copy and uploaded.

    Note where the cloud's version lives at this point: the remote already
    holds the *local* version, so ``keep_remote`` reads the conflict copy rather
    than downloading. Downloading would hand back the very version the user
    just rejected.

    Keeping *both* needs no call: that is the state a conflict already leaves
    behind, and the copy syncs as an ordinary file from then on.

    Either way the baseline is rewritten to the resolved content, so the next
    pass sees one agreed version instead of reporting the same conflict again.
    """
    resolution = str(resolution or "").strip()
    if resolution not in CONFLICT_RESOLUTIONS:
        raise CloudError(
            f"Unknown conflict resolution {resolution!r}. "
            f"Expected one of: {', '.join(CONFLICT_RESOLUTIONS)}."
        )

    if not str(rel_path or "").strip():
        raise CloudError("A file path is required to resolve a conflict.")
    # A path that escapes the project is a caller error, not a sync failure, so
    # it is reported as one instead of surfacing as a ValueError traceback.
    try:
        rel_path = normalize_rel_path(rel_path)
        copy_rel = normalize_rel_path(conflict_copy) if str(conflict_copy or "").strip() else ""
    except ValueError as exc:
        raise CloudError(str(exc)) from exc

    state = load_state(project_path)
    if not state.settings.provider:
        raise CloudError("No cloud provider is configured for this project.")
    backend = provider or build_provider(state.settings)
    absolute = local_path_for(project_path, rel_path)

    try:
        root = state.root or backend.ensure_root(
            state.settings.remote_folder or os.path.basename(project_path), state.root
        )
        state.root = root

        if resolution == KEEP_REMOTE:
            copy_absolute = local_path_for(project_path, copy_rel) if copy_rel else ""
            if not copy_absolute or not os.path.isfile(copy_absolute):
                raise CloudError(
                    "The cloud version of this file is the conflict copy saved beside it, "
                    "and that copy is missing. Keep the local version instead, or restore "
                    "the copy and try again."
                )
            os.makedirs(os.path.dirname(absolute) or project_path, exist_ok=True)
            # Atomic, and it removes the copy in the same step.
            os.replace(copy_absolute, absolute)
        elif not os.path.isfile(absolute):
            raise CloudError(f"{rel_path} no longer exists locally.")

        entry = backend.upload(root, rel_path, absolute, None)
        state.record(
            rel_path,
            hash_=hash_file(absolute),
            size=os.path.getsize(absolute),
            mtime=os.path.getmtime(absolute),
            remote_rev=entry.remote_rev,
        )
        removed = _discard_conflict_copy(project_path, backend, state, copy_rel)
        save_state(project_path, state)
    finally:
        if provider is None:
            try:
                backend.close()
            except Exception:
                pass

    return {"path": rel_path, "resolution": resolution, "removed_copy": removed}


def _discard_conflict_copy(
    project_path: str,
    backend: CloudStorageProvider,
    state: CloudState,
    copy_rel: str,
) -> str:
    """Delete a conflict copy that the resolution just made redundant.

    Best effort on the remote side: the copy reaches the cloud only on the pass
    after the conflict, so it is often not there at all, and failing to delete a
    spare copy must not undo a resolution that already succeeded locally.
    """
    if not copy_rel:
        return ""
    absolute_copy = local_path_for(project_path, copy_rel)
    try:
        os.remove(absolute_copy)
    except FileNotFoundError:
        pass
    except OSError:
        return ""
    if copy_rel in state.entries:
        try:
            backend.delete(state.root, copy_rel, None)
        except CloudError:
            pass
        state.forget(copy_rel)
    return copy_rel


# ─── Per-file state, for the explorer's badges ────────────────────────────────

SYNCED = "synced"
PENDING = "pending"
SYNCING = "syncing"
CONFLICT = "conflict"
EXCLUDED = "excluded"

# Worst-first, which is what a folder inherits from its subtree: one conflicted
# file has to be visible from a collapsed folder, and "synced" is the state a
# folder only earns when nothing inside it is waiting.
_STATE_SEVERITY = {EXCLUDED: 0, SYNCED: 1, PENDING: 2, SYNCING: 3, CONFLICT: 4}

# Scanning the whole tree on every poll would be wasteful while a pass is
# running and the panel refreshes every second. The scan-derived part of the
# answer is cached for this long; the parts that change by the second (the file
# in flight, the conflicts) are overlaid fresh on every call.
_FILE_STATE_TTL = 4.0

_FILE_STATE_CACHE: dict[str, tuple[float, dict[str, str]]] = {}
_FILE_STATE_LOCK = threading.Lock()


def _scanned_file_states(project_path: str, state: CloudState) -> dict[str, str]:
    """Compare the working copy against the baseline, memoized briefly."""
    key = _key(project_path)
    now = time.monotonic()
    with _FILE_STATE_LOCK:
        cached = _FILE_STATE_CACHE.get(key)
        if cached and (now - cached[0]) < _FILE_STATE_TTL:
            return dict(cached[1])

    scan = scan_project(project_path, state.settings, baseline=state.entries)
    states: dict[str, str] = {}
    for rel_path, entry in scan.entries.items():
        baseline = state.entries.get(rel_path)
        states[rel_path] = SYNCED if baseline and baseline.hash == entry.hash else PENDING
    for rel_path in scan.skipped:
        states[rel_path] = EXCLUDED

    with _FILE_STATE_LOCK:
        _FILE_STATE_CACHE[key] = (now, dict(states))
    return states


def invalidate_file_states(project_path: str) -> None:
    """Drop the memoized scan so the next read reflects a pass that just ran."""
    with _FILE_STATE_LOCK:
        _FILE_STATE_CACHE.pop(_key(project_path), None)


def file_states(
    project_path: str, conflicts: Optional[list[str]] = None
) -> dict[str, Any]:
    """Per-file sync state for the workspace tree.

    This is what lets the explorer mark files the way a desktop Drive client
    does — synced, waiting to go up, in flight, conflicted — instead of leaving
    the user to infer it from a status line that describes the project as a
    whole. Directories inherit the worst state in their subtree, so a collapsed
    folder still shows that something inside it needs attention.

    Paths are project-relative and POSIX-separated, matching both the workspace
    tree and the sync baseline.
    """
    state = load_state(project_path)
    if not state.settings.enabled or not state.settings.provider:
        return {"enabled": False, "states": {}, "current": "", "active": False}

    states = _scanned_file_states(project_path, state)

    for rel_path in conflicts or []:
        normalized = str(rel_path or "").replace("\\", "/").strip("/")
        if normalized:
            states[normalized] = CONFLICT

    progress = progress_for(project_path)
    current = str(progress.get("current_path") or "")
    if progress.get("active") and current:
        states[current] = SYNCING

    # Folders are not scanned entries; they take the worst state below them.
    for rel_path, value in list(states.items()):
        if value == EXCLUDED:
            continue
        parts = rel_path.split("/")[:-1]
        for depth in range(len(parts)):
            folder = "/".join(parts[: depth + 1])
            current_state = states.get(folder)
            if current_state is None or _STATE_SEVERITY[value] > _STATE_SEVERITY[current_state]:
                states[folder] = value

    return {
        "enabled": True,
        "states": states,
        "current": current if progress.get("active") else "",
        "active": bool(progress.get("active")),
    }


def status_for(project_path: str, project_name: str = "") -> dict[str, Any]:
    """Everything the UI needs to render the cloud panel for one project."""
    state = load_state(project_path)
    settings = state.settings
    providers = [
        {
            "id": info.id,
            "display_name": info.display_name,
            "requires_authorization": info.requires_authorization,
            "available": info.available,
            "unavailable_reason": info.unavailable_reason,
        }
        for info in list_providers()
    ]

    connected = False
    account = ""
    auth_error = ""
    if settings.provider:
        try:
            auth = build_provider(settings).auth_status()
            connected, account, auth_error = auth.connected, auth.account, auth.error
        except CloudError as exc:
            auth_error = str(exc)

    return {
        "project": project_name,
        "settings": {
            "enabled": settings.enabled,
            "provider": settings.provider,
            "remote_folder": settings.remote_folder,
            "include_build_artifacts": settings.include_build_artifacts,
            "include_dotenv": settings.include_dotenv,
            "auto_sync": settings.auto_sync,
            "debounce_seconds": settings.debounce_seconds,
            "poll_seconds": settings.poll_seconds,
            "extra_excludes": settings.extra_excludes,
            "provider_config": settings.provider_config,
        },
        "providers": providers,
        "connected": connected,
        "account": account,
        "auth_error": auth_error,
        "last_sync_at": state.last_sync_at,
        "last_error": state.last_error,
        "tracked_files": len(state.entries),
        "progress": progress_for(project_path),
    }


def update_settings(project_path: str, changes: dict[str, Any]) -> CloudSettings:
    """Apply a partial settings update and persist it."""
    current = load_state(project_path).settings
    merged = {
        "enabled": current.enabled,
        "provider": current.provider,
        "remote_folder": current.remote_folder,
        "include_build_artifacts": current.include_build_artifacts,
        "include_dotenv": current.include_dotenv,
        "auto_sync": current.auto_sync,
        "debounce_seconds": current.debounce_seconds,
        "poll_seconds": current.poll_seconds,
        "extra_excludes": current.extra_excludes,
        "provider_config": current.provider_config,
    }
    merged.update({key: value for key, value in (changes or {}).items() if key in merged})
    settings = CloudSettings.from_dict(merged)
    save_settings(project_path, settings)
    return settings


class CloudSyncManager:
    """Owns the background sync task for every project that has it enabled.

    One manager per application process; the IDE server creates it and drives it
    from the request handlers.
    """

    def __init__(self):
        self._projects: dict[str, _Registration] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    # -- registration ----------------------------------------------------------

    def activate(self, project_name: str, project_path: str) -> bool:
        """Start (or refresh) the background task for a project.

        Returns True when a task is running afterwards. Called when a project is
        opened and whenever its settings change.
        """
        key = _key(project_path)
        settings = load_state(project_path).settings
        if not (settings.enabled and settings.provider and settings.auto_sync):
            self.deactivate(project_path)
            return False

        registration = self._projects.get(key)
        if registration is None:
            registration = _Registration(project_name=project_name, project_path=project_path)
            self._projects[key] = registration
        else:
            registration.project_name = project_name

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No event loop here (CLI use). Automatic syncing needs the
            # server's loop; on-demand syncing still works.
            return False
        if registration.task is None or registration.task.done():
            registration.task = loop.create_task(self._run_loop(registration))
        if registration.watch_task is None or registration.watch_task.done():
            registration.watch_task = loop.create_task(self._watch_local(registration))
        return True

    def delete_remote_copy(
        self,
        project_path: str,
        *,
        wait_seconds: float = 30.0,
        provider: Optional[CloudStorageProvider] = None,
    ) -> dict[str, Any]:
        """Delete the project's cloud folder once no pass is using it. Blocking.

        A pass still running would keep writing into the folder being removed,
        so it is cancelled and waited for first — it stops after the file in
        flight. Stopping the background task is the caller's job, from the event
        loop that owns it (:meth:`deactivate`); this runs in a worker thread.
        """
        request_cancel(project_path)
        lock = self._lock_for(project_path)
        if not lock.acquire(timeout=wait_seconds):
            raise CloudError(
                "A sync of this project is still finishing. Try again in a moment."
            )
        try:
            return delete_remote_project(project_path, provider=provider)
        finally:
            lock.release()

    def deactivate(self, project_path: str) -> None:
        registration = self._projects.pop(_key(project_path), None)
        if registration:
            for task in (registration.task, registration.watch_task):
                if task and not task.done():
                    task.cancel()

    def shutdown(self) -> None:
        for path in list(self._projects):
            self.deactivate(path)

    # -- triggers --------------------------------------------------------------

    def notify_local_change(self, project_path: str) -> None:
        """Announce that something under `project_path` changed.

        Cheap and non-blocking: request handlers call it on every write, so it
        must never do I/O.
        """
        registration = self._projects.get(_key(project_path))
        if registration is not None:
            try:
                registration.dirty.set()
            except RuntimeError:
                pass

    def last_outcome(self, project_path: str) -> Optional[SyncOutcome]:
        registration = self._projects.get(_key(project_path))
        return registration.last_outcome if registration else None

    def is_running(self, project_path: str) -> bool:
        registration = self._projects.get(_key(project_path))
        return bool(registration and registration.running)

    # -- execution -------------------------------------------------------------

    def _lock_for(self, project_path: str) -> threading.Lock:
        """One lock per project, so two passes can never interleave.

        Concurrent passes would race on the baseline file and could upload a
        file twice or resurrect one that the other just deleted.
        """
        key = _key(project_path)
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    async def sync_now(
        self,
        project_name: str,
        project_path: str,
        *,
        direction: str = TWO_WAY,
        dry_run: bool = False,
        allow_bulk_delete: bool = False,
    ) -> SyncOutcome:
        """Run a pass off the event loop and return its outcome."""
        return await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: self._sync_blocking(
                project_name,
                project_path,
                direction=direction,
                dry_run=dry_run,
                allow_bulk_delete=allow_bulk_delete,
            ),
        )

    def _sync_blocking(
        self,
        project_name: str,
        project_path: str,
        *,
        direction: str,
        dry_run: bool,
        allow_bulk_delete: bool,
    ) -> SyncOutcome:
        lock = self._lock_for(project_path)
        # A pass already under way covers whatever this caller wanted synced, so
        # waiting for it is pointless work; the caller is told to look at the
        # pass that is already running.
        if not lock.acquire(blocking=False):
            return SyncOutcome(error="A sync is already running for this project.")
        registration = self._projects.get(_key(project_path))
        if registration is not None:
            registration.running = True
        outcome = None
        try:
            outcome = sync_project(
                project_name,
                project_path,
                direction=direction,
                dry_run=dry_run,
                allow_bulk_delete=allow_bulk_delete,
            )
        except Exception as exc:
            # sync_project reports the failures it anticipates through the
            # outcome. Anything else escaped it: report it the same way, naming
            # its type, so the status shows the real cause and the background
            # loop keeps polling. Reading `outcome` below without this raised
            # UnboundLocalError, which hid the original error and stopped the loop.
            traceback.print_exc()
            outcome = SyncOutcome(error=f"Unexpected sync failure: {type(exc).__name__}: {exc}")
        finally:
            lock.release()
            if registration is not None:
                registration.running = False
                if not dry_run and outcome is not None:
                    registration.last_outcome = outcome
        return outcome

    async def _watch_local(self, registration: _Registration) -> None:
        """Announce edits made directly on disk (Claude Code), until cancelled."""
        try:
            await _watch_project(registration, LOCAL_WATCH_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[gilzacode.cloud] Local watch stopped for {registration.project_path}: {exc}")

    async def _run_loop(self, registration: _Registration) -> None:
        """Debounce local changes and poll the remote, until cancelled."""
        try:
            while True:
                settings = load_state(registration.project_path).settings
                if not (settings.enabled and settings.provider and settings.auto_sync):
                    return

                poll = settings.poll_seconds if settings.poll_seconds > 0 else None
                try:
                    await asyncio.wait_for(registration.dirty.wait(), timeout=poll)
                    # Local change announced: wait out the quiet period, and
                    # restart it whenever another change lands, so a pass runs
                    # once the burst is over rather than in the middle of it.
                    deadline = time.monotonic() + settings.debounce_seconds
                    registration.dirty.clear()
                    while time.monotonic() < deadline:
                        remaining = deadline - time.monotonic()
                        try:
                            await asyncio.wait_for(registration.dirty.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            break
                        registration.dirty.clear()
                        deadline = time.monotonic() + settings.debounce_seconds
                except asyncio.TimeoutError:
                    pass  # poll interval elapsed; sync to pick up remote edits

                registration.dirty.clear()
                await self.sync_now(registration.project_name, registration.project_path)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # The loop is a background task: an unhandled exception would
            # disappear into the event loop and silently stop syncing.
            print(f"[gilzacode.cloud] Sync loop stopped for {registration.project_path}: {exc}")


async def _watch_project(registration: "_Registration", interval: float) -> None:
    previous = None
    while True:
        settings = load_state(registration.project_path).settings
        current = await asyncio.to_thread(local_signature, registration.project_path, settings)
        # Every change is announced, even one seen while a pass runs: the edit
        # may have landed after that pass scanned, and the run loop holds the
        # announcement until the pass ends. A pass that downloaded changes the
        # sync set too, so one more pass follows it and finds nothing to do;
        # that costs a listing, where ignoring it could leave an edit unsynced
        # until the next poll.
        if previous is not None and current != previous:
            registration.dirty.set()
        previous = current
        await asyncio.sleep(interval)


def _key(project_path: str) -> str:
    return os.path.abspath(project_path)


# Process-wide manager used by the IDE server.
MANAGER = CloudSyncManager()
