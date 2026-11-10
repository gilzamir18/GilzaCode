"""File replacement for the atomic writes of the cloud sync.

Every atomic write here goes through a temp file next to its target and an
`os.replace`. On Windows another process (antivirus, the search indexer) often
opens a freshly written file for a moment, and a replace or delete that lands in
that window fails with a sharing violation even though nothing is wrong. Observed
on a 23 MB chat export: the replace failed, the temp file could not be removed
either, and the sync then uploaded the stray temp file as project content.

These operations retry that specific failure for a bounded time and then raise
the original error. Any other error is raised at once.
"""

from __future__ import annotations

import os
import time

# ERROR_ACCESS_DENIED and ERROR_SHARING_VIOLATION: what a replace or delete
# reports while another process briefly holds the file open.
_TRANSIENT_LOCK_WINERRORS = frozenset({5, 32})

# About three seconds in total, which covers a scan of a freshly written file.
RETRY_DELAYS_SECONDS = (0.05, 0.1, 0.2, 0.4, 0.8, 1.6)


def is_transient_lock(exc: BaseException) -> bool:
    return isinstance(exc, PermissionError) and getattr(exc, "winerror", None) in _TRANSIENT_LOCK_WINERRORS


def _with_lock_retries(operation, *args):
    for delay in RETRY_DELAYS_SECONDS:
        try:
            return operation(*args)
        except OSError as exc:
            if not is_transient_lock(exc):
                raise
            time.sleep(delay)
    return operation(*args)


def replace_file(source: str, destination: str) -> None:
    """`os.replace`, retried while another process briefly holds either file."""
    _with_lock_retries(os.replace, source, destination)


def discard_file(path: str) -> None:
    """Remove a temp file, retried the same way; a file already gone is fine."""
    try:
        _with_lock_retries(os.unlink, path)
    except FileNotFoundError:
        pass
