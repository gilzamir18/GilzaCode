"""The provider-neutral sync engine.

The engine reconciles three views of the project:

* **local** — what the filesystem holds now (from :mod:`.scanner`);
* **remote** — what the provider lists now;
* **base** — what the two agreed on at the end of the previous sync
  (:class:`~.state.CloudState.entries`).

Comparing all three is what lets the engine tell *which side* changed. A
two-way design without a baseline can only see "these differ" and has to guess a
winner, which is how sync tools silently discard work.

When both sides changed, the engine never merges. It keeps the local file, saves
the remote version beside it as a clearly named conflict copy, and reports the
conflict. Auto-merging LaTeX would produce a file that still compiles while
saying something the author never wrote.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Optional

from .base import (
    CloudAuthError,
    CloudError,
    CloudPreconditionFailed,
    CloudRootMissing,
    CloudStorageProvider,
    RemoteEntry,
    hash_file,
    local_path_for,
)
from .scanner import DEFAULT_MAX_FILE_SIZE, ExclusionPolicy, LocalEntry, ScanResult, scan_project
from .state import CloudSettings, CloudState

# Sync directions.
TWO_WAY = "two-way"
PUSH = "push"      # local is authoritative; never writes to the working copy
PULL = "pull"      # remote is authoritative; never writes to the remote

# Safety valve for mass local deletions driven by the remote. A provider that
# answers with an empty or truncated listing — a revoked token surfacing as an
# empty folder, a folder recreated by hand, a partial page — would otherwise be
# read as "the user deleted everything" and wipe the working copy.
BULK_DELETE_MIN = 10
BULK_DELETE_RATIO = 0.5


@dataclass(frozen=True)
class ProgressEvent:
    """One step of a pass, reported while it happens.

    The engine reaches every file in the plan, so ``index``/``total`` advance
    even through files that turn out to need no transfer — otherwise a pass over
    a large project looks stalled between two changed files.
    """

    action: str  # plan | visit | upload | download | delete-remote | delete-local | conflict
    rel_path: str = ""
    index: int = 0
    total: int = 0


@dataclass
class Conflict:
    rel_path: str
    # Where the remote version was written so the user can diff it.
    conflict_copy: str
    resolution: str = "kept-local"


@dataclass
class SyncReport:
    uploaded: list[str] = field(default_factory=list)
    downloaded: list[str] = field(default_factory=list)
    deleted_remote: list[str] = field(default_factory=list)
    deleted_local: list[str] = field(default_factory=list)
    # Files whose deletion on one side was undone because the other side had
    # edited them; the edit wins over the delete.
    restored: list[str] = field(default_factory=list)
    conflicts: list[Conflict] = field(default_factory=list)
    skipped: dict[str, str] = field(default_factory=dict)
    errors: list[tuple[str, str]] = field(default_factory=list)
    aborted: str = ""
    # The user stopped the pass. Everything that completed before the stop is
    # in the baseline, so the next pass carries on from there.
    cancelled: bool = False
    # The remote folder this project was mirrored to is gone. Nothing was
    # touched on either side; only the user can say whether to publish the
    # project again or stop syncing it.
    remote_missing: bool = False
    dry_run: bool = False
    duration_seconds: float = 0.0

    @property
    def ok(self) -> bool:
        return not self.errors and not self.aborted

    @property
    def changed(self) -> int:
        return (
            len(self.uploaded)
            + len(self.downloaded)
            + len(self.deleted_remote)
            + len(self.deleted_local)
            + len(self.restored)
        )

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "uploaded": self.uploaded,
            "downloaded": self.downloaded,
            "deleted_remote": self.deleted_remote,
            "deleted_local": self.deleted_local,
            "restored": self.restored,
            "conflicts": [
                {"path": c.rel_path, "conflict_copy": c.conflict_copy, "resolution": c.resolution}
                for c in self.conflicts
            ],
            "skipped": self.skipped,
            "errors": [{"path": p, "message": m} for p, m in self.errors],
            "aborted": self.aborted,
            "cancelled": self.cancelled,
            "remote_missing": self.remote_missing,
            "dry_run": self.dry_run,
            "changed": self.changed,
            "duration_seconds": round(self.duration_seconds, 3),
        }


class BulkDeleteRefused(CloudError):
    """The remote asked to delete a suspicious share of the working copy."""


class SyncCancelled(CloudError):
    """The pass was stopped on request, between two files."""


def conflict_copy_name(rel_path: str, when: Optional[datetime] = None) -> str:
    """Name for the preserved remote version of a conflicted file.

    The stamp goes before the extension so the copy keeps its file type: a
    conflicted ``main.tex`` stays a ``.tex`` the editor will open and highlight,
    instead of becoming an unopenable ``main.tex.conflict``.
    """
    stamp = (when or datetime.now()).strftime("%Y%m%d-%H%M%S")
    directory, name = rel_path.rsplit("/", 1) if "/" in rel_path else ("", rel_path)
    stem, dot, extension = name.partition(".")
    suffix = f"{dot}{extension}" if dot else ""
    candidate = f"{stem} (cloud conflict {stamp}){suffix}"
    return f"{directory}/{candidate}" if directory else candidate


class SyncEngine:
    """Reconciles one project against one provider. Not thread-safe by design:
    the service layer serializes passes per project."""

    def __init__(
        self,
        project_path: str,
        provider: CloudStorageProvider,
        state: CloudState,
        *,
        direction: str = TWO_WAY,
        settings: Optional[CloudSettings] = None,
        on_progress: Optional[Callable[[ProgressEvent], None]] = None,
        persist: Optional[Callable[[CloudState], None]] = None,
        allow_bulk_delete: bool = False,
        should_cancel: Optional[Callable[[], bool]] = None,
    ):
        self.project_path = os.path.abspath(project_path)
        self.provider = provider
        self.state = state
        self.settings = settings or state.settings
        self.direction = direction if direction in {TWO_WAY, PUSH, PULL} else TWO_WAY
        self.on_progress = on_progress
        self.persist = persist
        self.allow_bulk_delete = allow_bulk_delete
        self.should_cancel = should_cancel
        self._capabilities = provider.capabilities()
        # Position within the plan, so every progress event can carry it
        # without threading the counter through each reconcile helper.
        self._index = 0
        self._total = 0

    # -- public API ------------------------------------------------------------

    def run(self, dry_run: bool = False) -> SyncReport:
        started = time.monotonic()
        report = SyncReport(dry_run=dry_run)
        try:
            self._run(report, dry_run)
        except CloudAuthError as exc:
            report.aborted = f"auth: {exc}"
        except SyncCancelled as exc:
            report.aborted = str(exc)
            report.cancelled = True
        except CloudRootMissing as exc:
            report.aborted = (
                f"{exc} Syncing stopped and no local file was touched. Upload the "
                f"project again to create a new cloud copy, or turn cloud sync off."
            )
            report.remote_missing = True
        except BulkDeleteRefused as exc:
            report.aborted = str(exc)
        except CloudError as exc:
            report.aborted = str(exc)
        report.duration_seconds = time.monotonic() - started
        self.state.mark_synced(report.aborted or "")
        if not dry_run:
            self._persist()
        return report

    # -- internals -------------------------------------------------------------

    def _progress(self, action: str, rel_path: str = "") -> None:
        if self.on_progress:
            try:
                self.on_progress(
                    ProgressEvent(
                        action=action, rel_path=rel_path, index=self._index, total=self._total
                    )
                )
            except Exception:
                # A misbehaving progress listener must never abort a sync.
                pass

    def _persist(self) -> None:
        if self.persist:
            self.persist(self.state)

    def _check_cancelled(self) -> None:
        """Stop the pass here if the user asked for it.

        Checked only *between* files: a transfer already under way finishes, so
        the baseline never records a file that did not fully arrive, and every
        file that did is recorded — the next pass resumes instead of redoing it.
        """
        if self.should_cancel is not None and self.should_cancel():
            raise SyncCancelled("Sync cancelled by the user.")

    def _run(self, report: SyncReport, dry_run: bool) -> None:
        folder = self.settings.remote_folder or os.path.basename(self.project_path)
        self._check_cancelled()
        root = self.provider.ensure_root(folder, self.state.root)
        if root != self.state.root:
            self.state.root = root

        self._check_cancelled()
        scan: ScanResult = scan_project(
            self.project_path, self.settings, baseline=self.state.entries
        )
        report.skipped = scan.skipped
        local = scan.entries
        remote = {entry.rel_path: entry for entry in self.provider.list_entries(root) if not entry.is_dir}
        base = self.state.entries
        self._check_cancelled()

        # A conflict copy created by an earlier pass is a normal file from here
        # on: it uploads like any other, so both machines can see the divergence.
        policy = ExclusionPolicy(self.settings)
        plan = []
        for path in sorted(set(local) | set(remote) | set(base)):
            reason = policy.reason_to_skip(path) or scan.skipped.get(path)
            if not reason and path in remote and remote[path].size > DEFAULT_MAX_FILE_SIZE:
                reason = "too-large"
            if reason:
                report.skipped[path] = reason
                continue
            plan.append(path)

        self._guard_bulk_delete(plan, local, remote, base)

        self._index = 0
        self._total = len(plan)
        self._progress("plan")

        for position, rel_path in enumerate(plan, start=1):
            self._check_cancelled()
            self._index = position
            self._progress("visit", rel_path)
            try:
                self._reconcile(rel_path, local.get(rel_path), remote.get(rel_path), report, dry_run)
            except CloudAuthError:
                raise
            except CloudError as exc:
                report.errors.append((rel_path, str(exc)))
            except OSError as exc:
                report.errors.append((rel_path, str(exc)))

    def _guard_bulk_delete(
        self,
        plan: list[str],
        local: dict[str, LocalEntry],
        remote: dict[str, RemoteEntry],
        base: dict,
    ) -> None:
        """Refuse a pass that would delete a large share of the working copy.

        Only deletions *driven by the remote* count: files present locally and in
        the baseline, absent from the listing, and unmodified since the baseline.
        Those are exactly the ones a bogus empty listing would destroy.
        """
        if self.direction == PUSH or self.allow_bulk_delete:
            return
        candidates = [
            rel_path
            for rel_path in plan
            if rel_path in base and rel_path in local and rel_path not in remote
            and local[rel_path].hash == base[rel_path].hash
        ]
        if len(candidates) < BULK_DELETE_MIN:
            return
        tracked = max(1, len([p for p in base if p in local]))
        if len(candidates) / tracked < BULK_DELETE_RATIO:
            return
        raise BulkDeleteRefused(
            f"Refusing to delete {len(candidates)} local file(s) that vanished from the "
            f"remote in a single pass. This usually means the remote folder was emptied, "
            f"replaced, or listed incompletely — not that you deleted the files. "
            f"Re-run with bulk deletion allowed if the removal was intentional."
        )

    def _reconcile(
        self,
        rel_path: str,
        local: Optional[LocalEntry],
        remote: Optional[RemoteEntry],
        report: SyncReport,
        dry_run: bool,
    ) -> None:
        base = self.state.entries.get(rel_path)

        if local is None and remote is None:
            self.state.forget(rel_path)
            return

        if base is None:
            self._reconcile_untracked(rel_path, local, remote, report, dry_run)
            return

        local_changed = local is None or local.hash != base.hash
        remote_changed = remote is None or remote.remote_rev != base.remote_rev

        if not local_changed and not remote_changed:
            return

        if local_changed and not remote_changed:
            if local is None:
                self._delete_remote(rel_path, base.remote_rev, report, dry_run)
            else:
                self._upload(rel_path, local, base.remote_rev, report, dry_run)
            return

        if remote_changed and not local_changed:
            if remote is None:
                self._delete_local(rel_path, report, dry_run)
            else:
                self._download(rel_path, remote, report, dry_run)
            return

        # Both sides moved since the baseline.
        if local is None and remote is None:
            self.state.forget(rel_path)
            return
        if local is None:
            # Deleted here, edited there. An edit carries intent that a delete
            # on a stale copy does not, so the edit is restored.
            if self.direction != PUSH:
                self._download(rel_path, remote, report, dry_run)
                report.restored.append(rel_path)
            return
        if remote is None:
            # Deleted there, edited here — same rule, mirrored.
            if self.direction != PULL:
                self._upload(rel_path, local, None, report, dry_run)
                report.restored.append(rel_path)
            return
        self._resolve_conflict(rel_path, local, remote, report, dry_run)

    def _reconcile_untracked(
        self,
        rel_path: str,
        local: Optional[LocalEntry],
        remote: Optional[RemoteEntry],
        report: SyncReport,
        dry_run: bool,
    ) -> None:
        """Handle a path the baseline has never seen."""
        if local is not None and remote is None:
            self._upload(rel_path, local, None, report, dry_run)
            return
        if local is None and remote is not None:
            self._download(rel_path, remote, report, dry_run)
            return
        # Present on both sides with no shared history: the same file was created
        # independently, or this is the first sync of an already-mirrored folder.
        if self._same_content(rel_path, local, remote):
            # Identical bytes: adopt the pairing without moving anything.
            self.state.record(
                rel_path,
                hash_=local.hash,
                size=local.size,
                mtime=local.mtime,
                remote_rev=remote.remote_rev,
            )
            return
        self._resolve_conflict(rel_path, local, remote, report, dry_run)

    def _same_content(
        self, rel_path: str, local: Optional[LocalEntry], remote: Optional[RemoteEntry]
    ) -> bool:
        """Best-effort content comparison across the provider boundary.

        Falls back to False when the provider reports no checksum: claiming two
        files match on size alone would silently discard one of them.
        """
        if local is None or remote is None:
            return False
        algorithm = self._capabilities.checksum_algorithm
        if not algorithm or not remote.checksum:
            return False
        if remote.size and remote.size != local.size:
            return False
        try:
            return hash_file(local_path_for(self.project_path, rel_path), algorithm) == remote.checksum
        except (OSError, ValueError):
            return False

    # -- individual operations -------------------------------------------------

    def _upload(
        self,
        rel_path: str,
        local: LocalEntry,
        expected_rev: Optional[str],
        report: SyncReport,
        dry_run: bool,
    ) -> None:
        if self.direction == PULL:
            return
        self._progress("upload", rel_path)
        if dry_run:
            report.uploaded.append(rel_path)
            return
        condition = expected_rev if self._capabilities.conditional_writes else None
        try:
            with self._upload_snapshot(rel_path) as (absolute, sent):
                entry = self.provider.upload(self.state.root, rel_path, absolute, condition)
        except CloudPreconditionFailed:
            # The remote moved between the listing and this write. Re-fetch its
            # current state and reconcile again rather than overwriting a change
            # this pass never saw.
            current = self._refetch(rel_path)
            if current is None:
                with self._upload_snapshot(rel_path) as (absolute, sent):
                    entry = self.provider.upload(self.state.root, rel_path, absolute, None)
            else:
                self._resolve_conflict(rel_path, local, current, report, dry_run)
                return
        # Keep the metadata from the snapshot, never from a later local edit.
        # A later edit must miss the scanner's hash cache on the next pass.
        self.state.record(
            rel_path, hash_=sent.hash, size=sent.size, mtime=sent.mtime, remote_rev=entry.remote_rev
        )
        report.uploaded.append(rel_path)

    def _download(
        self, rel_path: str, remote: RemoteEntry, report: SyncReport, dry_run: bool
    ) -> None:
        if self.direction == PUSH:
            return
        self._progress("download", rel_path)
        if dry_run:
            report.downloaded.append(rel_path)
            return
        absolute = local_path_for(self.project_path, rel_path)
        os.makedirs(os.path.dirname(absolute), exist_ok=True)
        entry = self.provider.download(self.state.root, rel_path, absolute)
        digest = hash_file(absolute)
        size, mtime = _stat_or(absolute, entry.size, 0.0)
        self.state.record(
            rel_path,
            hash_=digest,
            size=size,
            mtime=mtime,
            remote_rev=entry.remote_rev or remote.remote_rev,
        )
        report.downloaded.append(rel_path)

    def _delete_remote(
        self, rel_path: str, expected_rev: Optional[str], report: SyncReport, dry_run: bool
    ) -> None:
        if self.direction == PULL:
            return
        self._progress("delete-remote", rel_path)
        if dry_run:
            report.deleted_remote.append(rel_path)
            return
        condition = expected_rev if self._capabilities.conditional_writes else None
        self.provider.delete(self.state.root, rel_path, condition)
        self.state.forget(rel_path)
        report.deleted_remote.append(rel_path)

    def _delete_local(self, rel_path: str, report: SyncReport, dry_run: bool) -> None:
        if self.direction == PUSH:
            return
        self._progress("delete-local", rel_path)
        if dry_run:
            report.deleted_local.append(rel_path)
            return
        absolute = local_path_for(self.project_path, rel_path)
        try:
            os.remove(absolute)
        except FileNotFoundError:
            pass
        self.state.forget(rel_path)
        report.deleted_local.append(rel_path)

    def _resolve_conflict(
        self,
        rel_path: str,
        local: LocalEntry,
        remote: RemoteEntry,
        report: SyncReport,
        dry_run: bool,
    ) -> None:
        """Keep the working copy, preserve the remote version beside it."""
        copy_path = conflict_copy_name(rel_path)
        self._progress("conflict", rel_path)
        if dry_run:
            report.conflicts.append(Conflict(rel_path=rel_path, conflict_copy=copy_path))
            return

        if self.direction != PUSH:
            absolute_copy = local_path_for(self.project_path, copy_path)
            os.makedirs(os.path.dirname(absolute_copy), exist_ok=True)
            self.provider.download(self.state.root, rel_path, absolute_copy)

        report.conflicts.append(Conflict(rel_path=rel_path, conflict_copy=copy_path))

        if self.direction == PULL:
            # A pull is defined as never writing to the remote, and that has to
            # hold for the conflict path too: publishing the working copy from
            # here would let a one-way fetch overwrite the very version it was
            # asked to fetch. The remote version is parked beside the local one
            # and the baseline is left untouched, so the divergence is still
            # there for a two-way pass to settle.
            return

        # The working copy wins the canonical path, so the user's open editor
        # buffer keeps matching the file on disk.
        with self._upload_snapshot(rel_path) as (absolute, sent):
            entry = self.provider.upload(self.state.root, rel_path, absolute, None)
        self.state.record(
            rel_path, hash_=sent.hash, size=sent.size, mtime=sent.mtime, remote_rev=entry.remote_rev
        )
        report.uploaded.append(rel_path)

    @contextmanager
    def _upload_snapshot(self, rel_path: str):
        """Send stable bytes and record the metadata of that same version."""
        source = local_path_for(self.project_path, rel_path)
        before = os.stat(source)
        with tempfile.TemporaryDirectory(prefix="gilzacode-upload-") as directory:
            snapshot = os.path.join(directory, os.path.basename(source))
            shutil.copyfile(source, snapshot)
            after = os.stat(source)
            signature = lambda stat: (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino)
            if signature(before) != signature(after):
                raise CloudError(f"File changed while preparing upload: {rel_path}. Retry the sync.")
            sent = LocalEntry(rel_path, before.st_size, before.st_mtime, hash_file(snapshot))
            yield snapshot, sent

    def _refetch(self, rel_path: str) -> Optional[RemoteEntry]:
        """Re-read one path's current remote state after a lost race."""
        try:
            for entry in self.provider.list_entries(self.state.root):
                if entry.rel_path == rel_path:
                    return entry
        except CloudError:
            return None
        return None


def _stat_or(path: str, size: int, mtime: float) -> tuple[int, float]:
    try:
        stat = os.stat(path)
        return stat.st_size, stat.st_mtime
    except OSError:
        return size, mtime
