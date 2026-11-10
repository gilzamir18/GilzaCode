"""Walk a project directory and describe what should be mirrored.

Change detection is manifest-based (path + size + mtime + content hash) rather
than built on the shadow git repository in ``.gilzacode/.shadowgit``. Two reasons
decided this:

* the shadow repo deliberately ignores LaTeX build output, so it cannot report
  changes to the artifacts this feature is asked to mirror; and
* the VCS strategy is user-configurable and ``NoGitStrategy`` exists, so a
  git-only design would leave those projects unable to sync at all.

Hashing every file on every pass would be wasteful, so the scanner takes the
usual shortcut: when a file's size and mtime match the sync baseline, its
recorded hash is reused and the bytes are never read.
"""

from __future__ import annotations

import fnmatch
import os
from dataclasses import dataclass
from typing import Iterable, Optional

from .base import hash_file, normalize_rel_path
from .state import CloudSettings, SyncEntry

# Never mirrored, under any setting. These are machine-local, regenerable, or
# would break the sync itself if copied between machines.
ALWAYS_EXCLUDED = (
    ".gilzacode/cloud/*",        # this machine's sync baseline
    ".git/*",
    ".hg/*",
    ".svn/*",
    "node_modules/*",
    "__pycache__/*",
    "*.pyc",
    "*.pyo",
    ".venv/*",
    "venv/*",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    # Partial-compilation scratch files written next to the source by the
    # LaTeX compiler; they exist only for the duration of one compile.
    "gilzacode_partial_*",
    # GilzaCode's per-machine LaTeX routing diagnostics (absolute paths).
    ".gilzacode/latex_compile_debug.json",
    # Temp files of the sync's own atomic writes (file downloads). One left
    # behind by a failed replace is not project content.
    "*.sync-*.tmp",
)

# Directory names pruned during the walk. Pruning beats matching every leaf:
# node_modules alone can hold tens of thousands of files.
PRUNED_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
    ".mypy_cache", ".pytest_cache", ".ruff_cache",
})

# Files larger than this are reported as skipped instead of uploaded. A single
# multi-gigabyte file in a project would otherwise stall every sync pass behind
# an upload the user never asked for.
DEFAULT_MAX_FILE_SIZE = 256 * 1024 * 1024


@dataclass(frozen=True)
class LocalEntry:
    rel_path: str
    size: int
    mtime: float
    hash: str


@dataclass
class ScanResult:
    entries: dict[str, LocalEntry]
    # rel_path -> human-readable reason, for files deliberately left out.
    skipped: dict[str, str]


def _build_artifact_suffixes() -> tuple[str, ...]:
    """Extensions treated as LaTeX build output.

    Read from the same `workspace_files.hidden_file_extensions` list the
    workspace tree already hides, so "build artifact" means one thing across the
    application instead of drifting into a second private list.
    """
    try:
        from gilzacode.settings import hidden_file_extensions as get_workspace_hidden_file_extensions

        extensions = get_workspace_hidden_file_extensions()
    except Exception:
        extensions = []
    return tuple(sorted({str(e).lower() for e in extensions if e}))


def _matches_any(rel_path: str, patterns: Iterable[str]) -> bool:
    """Match a project-relative path against glob patterns.

    A pattern ending in ``/*`` matches the directory and everything under it, so
    ``node_modules/*`` excludes the whole subtree rather than only its direct
    children — which is what `fnmatch` alone would do, since ``*`` happily spans
    separators but the literal prefix still has to line up.
    """
    for pattern in patterns:
        if not pattern:
            continue
        if fnmatch.fnmatch(rel_path, pattern):
            return True
        if pattern.endswith("/*") and rel_path.startswith(pattern[:-1]):
            return True
        # Bare directory name: exclude the subtree.
        if "/" not in pattern and "*" not in pattern and rel_path.startswith(pattern + "/"):
            return True
    return False


class ExclusionPolicy:
    """Decides which project-relative paths take part in the sync."""

    def __init__(self, settings: CloudSettings):
        self.settings = settings
        self._patterns: list[str] = list(ALWAYS_EXCLUDED) + list(settings.extra_excludes or [])
        self._artifact_suffixes = () if settings.include_build_artifacts else _build_artifact_suffixes()

    def reason_to_skip(self, rel_path: str) -> Optional[str]:
        """Return why `rel_path` is excluded, or None when it should be synced."""
        if any(part in PRUNED_DIRS for part in rel_path.split("/")[:-1]):
            return "excluded"
        name = rel_path.rsplit("/", 1)[-1]
        if not self.settings.include_dotenv and (name == ".env" or name.startswith(".env.")):
            # Project API keys live here; copying them into cloud storage is a
            # credential disclosure, so it takes an explicit opt-in.
            return "dotenv"
        if _matches_any(rel_path, self._patterns):
            return "excluded"
        lowered = name.lower()
        if self._artifact_suffixes and lowered.endswith(self._artifact_suffixes):
            return "build-artifact"
        return None

    def allows(self, rel_path: str) -> bool:
        return self.reason_to_skip(rel_path) is None


def scan_project(
    project_path: str,
    settings: CloudSettings,
    baseline: Optional[dict[str, SyncEntry]] = None,
    max_file_size: int = DEFAULT_MAX_FILE_SIZE,
) -> ScanResult:
    """Describe every file under `project_path` that should be mirrored."""
    root = os.path.abspath(project_path)
    policy = ExclusionPolicy(settings)
    known = baseline or {}
    entries: dict[str, LocalEntry] = {}
    skipped: dict[str, str] = {}

    for dirpath, dirnames, filenames in os.walk(root):
        # Prune in place so os.walk never descends into the heavy directories.
        dirnames[:] = [d for d in dirnames if d not in PRUNED_DIRS]
        # `.gilzacode/cloud` holds this machine's baseline; never walk into it.
        if os.path.abspath(dirpath) == os.path.join(root, ".gilzacode"):
            dirnames[:] = [d for d in dirnames if d != "cloud"]

        for filename in filenames:
            absolute = os.path.join(dirpath, filename)
            try:
                rel_path = normalize_rel_path(os.path.relpath(absolute, root))
            except ValueError:
                continue

            reason = policy.reason_to_skip(rel_path)
            if reason:
                skipped[rel_path] = reason
                continue

            # Symlinks are not mirrored: their target is meaningful only on this
            # machine, and following them can walk out of the project or loop.
            if os.path.islink(absolute):
                skipped[rel_path] = "symlink"
                continue

            try:
                stat = os.stat(absolute)
            except (OSError, ValueError):
                # Vanished between listing and stat (a compile cleaning up after
                # itself, most often). Treat it as absent.
                continue

            if max_file_size and stat.st_size > max_file_size:
                skipped[rel_path] = "too-large"
                continue

            previous = known.get(rel_path)
            if (
                previous is not None
                and previous.hash
                and previous.size == stat.st_size
                and _mtime_matches(previous.mtime, stat.st_mtime)
            ):
                digest = previous.hash
            else:
                try:
                    digest = hash_file(absolute)
                except OSError:
                    continue

            entries[rel_path] = LocalEntry(
                rel_path=rel_path, size=stat.st_size, mtime=stat.st_mtime, hash=digest
            )

    return ScanResult(entries=entries, skipped=skipped)


def _mtime_matches(recorded: float, actual: float) -> bool:
    """Compare the recorded and current mtimes for the hash fast path.

    The tolerance is float-representation noise only, not a real time window: a
    wider one would let an edit made within the same second as the previous sync
    keep the old hash forever, whenever the size happened to stay the same. That
    is a silent lost update, so the fast path is taken only on an exact match.
    """
    return abs(recorded - actual) < 1e-6
