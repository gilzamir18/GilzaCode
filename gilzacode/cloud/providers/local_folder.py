"""A provider backed by a directory on this machine.

It is useful on its own — pointing it at a mounted network share, an rclone
mount, or an external drive gives the same mirroring behaviour without any
account — and it doubles as the reference implementation of the facade: the sync
engine's whole test suite runs against it, offline and without credentials.

Keeping it honest keeps the abstraction honest. It reports the same capability
flags a real backend does and enforces `expected_rev` the same way, so a bug in
the engine's conditional-write handling fails here rather than only in
production against Google Drive.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from typing import Optional

from ..atomic import discard_file, replace_file

from ..base import (
    AuthChallenge,
    AuthState,
    Capabilities,
    CloudError,
    CloudPreconditionFailed,
    CloudRootMissing,
    CloudStorageProvider,
    RemoteEntry,
    RemoteProject,
    hash_file,
    normalize_rel_path,
)


class LocalFolderProvider(CloudStorageProvider):
    id = "local_folder"
    display_name = "Local folder"

    def __init__(self, base_dir: str):
        if not base_dir:
            raise CloudError("A base directory is required for the local folder provider.")
        self.base_dir = os.path.abspath(base_dir)

    # -- capabilities & auth ---------------------------------------------------

    def capabilities(self) -> Capabilities:
        return Capabilities(
            checksum_algorithm="sha256",
            conditional_writes=True,
            max_file_size=0,
            server_side_versioning=False,
            project_listing=True,
        )

    def auth_status(self) -> AuthState:
        # A directory needs no authorization, but it can be missing or read-only,
        # and the UI shows that in the same place it shows a revoked token.
        if not os.path.isdir(self.base_dir):
            return AuthState(connected=False, error=f"Directory not found: {self.base_dir}")
        if not os.access(self.base_dir, os.W_OK):
            return AuthState(connected=False, error=f"Directory is not writable: {self.base_dir}")
        return AuthState(connected=True, account=self.base_dir)

    def begin_authorization(self) -> AuthChallenge:
        raise CloudError("The local folder provider does not use authorization.")

    def complete_authorization(self, session: dict, response: dict) -> AuthState:
        return self.auth_status()

    def revoke(self) -> None:
        return None

    # -- remote workspace ------------------------------------------------------

    def ensure_root(self, folder_name: str, existing_root: str = "") -> str:
        if existing_root:
            candidate = os.path.abspath(existing_root)
            # Only reuse a handle that still points inside this base directory:
            # a state file copied from another machine can carry a path that
            # exists here but belongs to something else entirely.
            if _is_within(candidate, self.base_dir):
                if not os.path.isdir(candidate):
                    # See CloudRootMissing: re-creating it would let the
                    # baseline read an empty folder as mass deletion.
                    raise CloudRootMissing(
                        f"This project's folder is no longer in {self.base_dir} — it was "
                        f"deleted or moved."
                    )
                return candidate
        root = os.path.join(self.base_dir, _safe_folder_name(folder_name))
        os.makedirs(root, exist_ok=True)
        return root

    def list_projects(self) -> list[RemoteProject]:
        if not os.path.isdir(self.base_dir):
            return []
        projects: list[RemoteProject] = []
        for name in sorted(os.listdir(self.base_dir)):
            candidate = os.path.join(self.base_dir, name)
            # Symlinks are skipped for the same reason `list_entries` skips
            # them: what they point at is outside the mirror.
            if not os.path.isdir(candidate) or os.path.islink(candidate):
                continue
            try:
                modified_at = str(os.stat(candidate).st_mtime)
            except OSError:
                modified_at = ""
            projects.append(RemoteProject(name=name, root=candidate, modified_at=modified_at))
        return projects

    def list_entries(self, root: str) -> list[RemoteEntry]:
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            return []
        entries: list[RemoteEntry] = []
        for dirpath, _dirnames, filenames in os.walk(root):
            for filename in filenames:
                absolute = os.path.join(dirpath, filename)
                if os.path.islink(absolute):
                    continue
                try:
                    rel_path = normalize_rel_path(os.path.relpath(absolute, root))
                    stat = os.stat(absolute)
                except (OSError, ValueError):
                    continue
                entries.append(
                    RemoteEntry(
                        rel_path=rel_path,
                        remote_rev=_revision(stat.st_mtime_ns, stat.st_size),
                        size=stat.st_size,
                        modified_at=str(stat.st_mtime),
                        checksum=hash_file(absolute, "sha256"),
                    )
                )
        return entries

    def upload(
        self,
        root: str,
        rel_path: str,
        local_path: str,
        expected_rev: Optional[str] = None,
    ) -> RemoteEntry:
        target = self._resolve(root, rel_path)
        self._check_precondition(target, expected_rev)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        _atomic_copy(local_path, target)
        stat = os.stat(target)
        return RemoteEntry(
            rel_path=normalize_rel_path(rel_path),
            remote_rev=_revision(stat.st_mtime_ns, stat.st_size),
            size=stat.st_size,
            modified_at=str(stat.st_mtime),
            checksum=hash_file(target, "sha256"),
        )

    def download(self, root: str, rel_path: str, dest_path: str) -> RemoteEntry:
        source = self._resolve(root, rel_path)
        if not os.path.isfile(source):
            raise CloudError(f"Remote file not found: {rel_path}")
        os.makedirs(os.path.dirname(os.path.abspath(dest_path)), exist_ok=True)
        _atomic_copy(source, dest_path)
        stat = os.stat(source)
        return RemoteEntry(
            rel_path=normalize_rel_path(rel_path),
            remote_rev=_revision(stat.st_mtime_ns, stat.st_size),
            size=stat.st_size,
            modified_at=str(stat.st_mtime),
            checksum=hash_file(source, "sha256"),
        )

    def delete(self, root: str, rel_path: str, expected_rev: Optional[str] = None) -> None:
        target = self._resolve(root, rel_path)
        if not os.path.exists(target):
            return
        self._check_precondition(target, expected_rev)
        try:
            os.remove(target)
        except IsADirectoryError:
            raise CloudError(f"Refusing to delete a directory: {rel_path}")
        _prune_empty_parents(os.path.dirname(target), os.path.abspath(root))

    def delete_root(self, root: str) -> None:
        # A plain directory has no trash, so this is permanent; the capability
        # says so and the UI warns before the user confirms.
        target = os.path.abspath(root)
        if target == self.base_dir or not _is_within(target, self.base_dir):
            raise CloudError(f"Refusing to delete a folder outside the project mirror: {root!r}")
        if os.path.islink(target):
            raise CloudError(f"Refusing to delete a symbolic link: {root!r}")
        if os.path.isdir(target):
            shutil.rmtree(target)

    def about(self) -> dict:
        usage = shutil.disk_usage(self.base_dir) if os.path.isdir(self.base_dir) else None
        return {
            "provider": self.id,
            "base_dir": self.base_dir,
            "free_bytes": usage.free if usage else 0,
            "total_bytes": usage.total if usage else 0,
        }

    # -- helpers ---------------------------------------------------------------

    def _resolve(self, root: str, rel_path: str) -> str:
        root_abs = os.path.abspath(root)
        target = os.path.abspath(os.path.join(root_abs, normalize_rel_path(rel_path)))
        if not _is_within(target, root_abs):
            raise CloudError(f"rel_path escapes the remote root: {rel_path!r}")
        return target

    def _check_precondition(self, target: str, expected_rev: Optional[str]) -> None:
        if expected_rev is None:
            return
        try:
            stat = os.stat(target)
        except OSError:
            current = ""
        else:
            current = _revision(stat.st_mtime_ns, stat.st_size)
        if current != expected_rev:
            raise CloudPreconditionFailed(
                f"Remote revision changed (expected {expected_rev!r}, found {current!r})"
            )


def _revision(mtime_ns: int, size: int) -> str:
    """Opaque revision token. Combines mtime and size so a same-length rewrite
    still produces a new revision on filesystems with coarse timestamps."""
    return f"{mtime_ns}-{size}"


def _safe_folder_name(name: str) -> str:
    cleaned = "".join(ch for ch in str(name or "project") if ch not in '\\/:*?"<>|').strip()
    return cleaned or "project"


def _is_within(candidate: str, root: str) -> bool:
    return candidate == root or candidate.startswith(root.rstrip(os.sep) + os.sep)


def _atomic_copy(source: str, destination: str) -> None:
    """Copy through a temp file in the destination directory, then replace.

    A direct copy that is interrupted leaves a truncated file behind — which the
    next scan would hash and faithfully propagate as the new content.
    """
    directory = os.path.dirname(os.path.abspath(destination)) or "."
    os.makedirs(directory, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(dir=directory, prefix=".sync-", suffix=".tmp", delete=False)
    try:
        with handle:
            with open(source, "rb") as src:
                shutil.copyfileobj(src, handle)
            handle.flush()
            os.fsync(handle.fileno())
        replace_file(handle.name, destination)
    except BaseException:
        try:
            discard_file(handle.name)
        except OSError:
            pass
        raise


def _prune_empty_parents(directory: str, stop_at: str) -> None:
    """Remove directories left empty by a delete, up to (not including) the root."""
    current = os.path.abspath(directory)
    stop_at = os.path.abspath(stop_at)
    while _is_within(current, stop_at) and current != stop_at:
        try:
            os.rmdir(current)
        except OSError:
            return
        current = os.path.dirname(current)
