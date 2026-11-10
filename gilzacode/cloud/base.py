"""Provider-neutral contract for keeping an GilzaCode project in cloud storage.

The rest of the cloud package talks only to :class:`CloudStorageProvider`. No
Google Drive concept (file ids, ``application/vnd.google-apps`` mime types,
shared drives) may cross this boundary, otherwise a second provider cannot be
added without rewriting the sync engine.

Two rules keep the abstraction honest:

* **Paths are the identity.** Every operation addresses a file by ``rel_path``,
  a POSIX-style path relative to the project root. Providers that key storage
  by opaque ids (Drive) keep their own path -> id map internally; providers
  that are natively path-based (WebDAV, a local folder, S3) use the path as is.
* **Revisions are opaque.** ``remote_rev`` is a provider-defined token that
  changes whenever the remote content changes. The engine only ever compares it
  for equality; it never parses or orders it.
"""

from __future__ import annotations

import hashlib
import os
import posixpath
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Iterable, Optional


# ─── Errors ───────────────────────────────────────────────────────────────────

class CloudError(Exception):
    """Base class for every cloud-storage failure."""


class CloudAuthError(CloudError):
    """Credentials are missing, expired beyond refresh, or were revoked.

    The caller must restart the authorization flow; retrying the operation
    unchanged will keep failing.
    """


class CloudTransientError(CloudError):
    """A retryable failure: network hiccup, rate limit, 5xx from the backend."""


class CloudPreconditionFailed(CloudError):
    """A conditional write lost a race: the remote revision moved underneath us.

    The engine answers this by re-reading the remote state and re-deciding, not
    by overwriting blindly.
    """


class CloudQuotaExceeded(CloudError):
    """The account is out of storage. Not retryable without user action."""


class CloudNotFound(CloudError):
    """The backend answered that the addressed item does not exist."""


class CloudRootMissing(CloudError):
    """The project's remote folder, recorded by an earlier pass, is gone.

    It was deleted or trashed — typically because the project was deleted from
    the cloud on another machine — or it is not visible to the account now
    connected. A replacement must *not* be created silently: reconciling the
    baseline against a new, empty folder reads as "every file was deleted in
    the cloud" and deletes the working copy.
    """


# ─── Value objects ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RemoteEntry:
    """One file as the remote sees it.

    ``checksum`` is filled only when the provider can supply one cheaply, in the
    algorithm named by :attr:`Capabilities.checksum_algorithm`. It is an
    optimization — the engine must stay correct when it is ``None``.
    """

    rel_path: str
    remote_rev: str
    size: int = 0
    modified_at: str = ""
    checksum: Optional[str] = None
    is_dir: bool = False


@dataclass(frozen=True)
class RemoteProject:
    """One project folder found in the account, as an entry point for a clone.

    ``root`` is the same opaque handle :meth:`CloudStorageProvider.ensure_root`
    returns, so a machine that has never seen this project can be pointed
    straight at it without resolving the name again — which on a backend that
    keys by id rather than by name would otherwise risk creating a second folder
    with the same name.
    """

    name: str
    root: str
    modified_at: str = ""


@dataclass(frozen=True)
class Capabilities:
    """What a provider can do, so the engine never assumes a Drive-only feature."""

    # Algorithm of RemoteEntry.checksum ("md5", "sha256") or None when the
    # provider cannot report content hashes.
    checksum_algorithm: Optional[str] = None
    # Whether upload/delete honour `expected_rev` and raise
    # CloudPreconditionFailed instead of clobbering a concurrent write.
    conditional_writes: bool = False
    # Largest single file the provider accepts, 0 meaning "no known limit".
    max_file_size: int = 0
    # Whether the provider keeps its own version history of overwritten files.
    server_side_versioning: bool = False
    # Whether `list_projects` works. A backend that can only be pointed at one
    # folder (a single WebDAV URL, say) has nothing to enumerate, and the UI
    # offers the "download a project" flow only where this is true.
    project_listing: bool = False
    # Whether `delete_root` can be undone from the provider's own UI (a trash
    # or recycle bin). The UI says which it is before the user confirms.
    recoverable_root_deletion: bool = False


@dataclass
class AuthChallenge:
    """Everything the UI needs to walk the user through an authorization."""

    authorization_url: str
    # Opaque blob the provider needs back to finish the exchange (PKCE verifier,
    # redirect port, CSRF state). Never shown to the user.
    session: dict = field(default_factory=dict)
    # Human-readable hint shown while the browser tab is open.
    instructions: str = ""


@dataclass
class AuthState:
    """Result of asking a provider whether it is usable right now."""

    connected: bool = False
    account: str = ""
    scopes: list[str] = field(default_factory=list)
    error: str = ""


# ─── Helpers shared by every provider ─────────────────────────────────────────

_HASH_CHUNK = 1024 * 1024


def hash_file(path: str, algorithm: str = "sha256") -> str:
    """Hash a file's bytes with `algorithm`, streaming so large PDFs are safe."""
    digest = hashlib.new(algorithm)
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(_HASH_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def hash_bytes(data: bytes, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    digest.update(data)
    return digest.hexdigest()


def normalize_rel_path(rel_path: str) -> str:
    """Canonicalize a project-relative path to the wire form: POSIX, no leading
    slash, no ``.``/``..`` segments.

    Every provider and the state file agree on this form, so a project synced
    from Windows and pulled on Linux addresses the same remote file.
    """
    text = str(rel_path or "").replace("\\", "/").strip()
    while text.startswith("./"):
        text = text[2:]
    text = text.lstrip("/")
    normalized = posixpath.normpath(text) if text else ""
    if normalized in {".", ""}:
        raise ValueError("rel_path must name a file inside the project")
    if normalized.startswith("../") or normalized == "..":
        raise ValueError(f"rel_path escapes the project root: {rel_path!r}")
    return normalized


def local_path_for(project_path: str, rel_path: str) -> str:
    """Resolve `rel_path` under `project_path`, refusing to escape the root.

    Remote listings are untrusted input — a crafted entry name is the obvious
    way to make a pull write outside the project — so this check runs on every
    download, not only on user-supplied paths.
    """
    root = os.path.abspath(project_path)
    candidate = os.path.abspath(os.path.join(root, normalize_rel_path(rel_path)))
    if candidate != root and not candidate.startswith(root + os.sep):
        raise ValueError(f"rel_path escapes the project root: {rel_path!r}")
    return candidate


# ─── The facade ───────────────────────────────────────────────────────────────

class CloudStorageProvider(ABC):
    """A storage backend that can hold a mirror of a project directory.

    Implementations are constructed through :func:`gilzacode.cloud.registry.
    get_cloud_provider` and must be safe to use from a worker thread. They are
    *not* required to be thread-safe against concurrent calls on the same
    instance: the sync service serializes calls per project.
    """

    #: Stable identifier persisted in project state ("google_drive").
    id: str = ""
    #: Name shown in the UI. Providers keep it untranslated; the front-end maps
    #: `id` to a localized label.
    display_name: str = ""

    # -- capability reporting --------------------------------------------------

    @abstractmethod
    def capabilities(self) -> Capabilities:
        """Describe what this backend supports. Called often; keep it cheap."""

    # -- authorization ---------------------------------------------------------

    @abstractmethod
    def auth_status(self) -> AuthState:
        """Report whether stored credentials exist and are usable."""

    @abstractmethod
    def begin_authorization(self) -> AuthChallenge:
        """Start an authorization, returning the URL to open in a browser."""

    @abstractmethod
    def complete_authorization(self, session: dict, response: dict) -> AuthState:
        """Finish the flow started by :meth:`begin_authorization`.

        `session` is the blob from the challenge; `response` carries whatever
        the redirect delivered (for OAuth: ``code`` and ``state``).
        """

    @abstractmethod
    def revoke(self) -> None:
        """Forget stored credentials. Must not delete any remote data."""

    # -- remote workspace ------------------------------------------------------

    @abstractmethod
    def ensure_root(self, folder_name: str, existing_root: str = "") -> str:
        """Return an opaque handle for the project's remote folder, creating it
        if needed.

        When `existing_root` is a handle from a previous session it is validated
        and reused, so renaming the folder in the provider's own UI does not
        orphan the project. When that folder no longer exists, raise
        :class:`CloudRootMissing` instead of creating a replacement; any other
        failure to check it (a network error) propagates as itself, so it is
        never mistaken for a deletion.
        """

    def list_projects(self) -> list["RemoteProject"]:
        """List the projects already mirrored in this account.

        This is what lets a second machine find a project it has never seen. It
        is deliberately *not* abstract: a backend that addresses exactly one
        folder has nothing to enumerate, and must keep working without it.
        Implementations that do support it set ``Capabilities.project_listing``
        so callers can tell before asking, and must **not** create anything —
        listing is a read.
        """
        raise CloudError(
            f"{self.display_name or self.id or 'This backend'} cannot list projects."
        )

    @abstractmethod
    def list_entries(self, root: str) -> list[RemoteEntry]:
        """List every file under `root`, recursively, as project-relative paths."""

    @abstractmethod
    def upload(
        self,
        root: str,
        rel_path: str,
        local_path: str,
        expected_rev: Optional[str] = None,
    ) -> RemoteEntry:
        """Create or overwrite the remote file at `rel_path`.

        When the provider reports ``conditional_writes`` and `expected_rev` is
        given, a mismatch must raise :class:`CloudPreconditionFailed` rather
        than overwrite. ``expected_rev=None`` means "create or overwrite freely".
        """

    @abstractmethod
    def download(self, root: str, rel_path: str, dest_path: str) -> RemoteEntry:
        """Fetch `rel_path` into `dest_path`, creating parent directories.

        Implementations must write through a temporary file and replace the
        destination atomically, so an interrupted pull cannot leave a truncated
        .tex file in the project.
        """

    @abstractmethod
    def delete(self, root: str, rel_path: str, expected_rev: Optional[str] = None) -> None:
        """Remove the remote file. Deleting a missing file is not an error.

        Providers that support a recycle bin should prefer it over a permanent
        delete: a sync bug must not be able to destroy the user's only copy.
        """

    def delete_root(self, root: str) -> None:
        """Remove the project's whole remote folder, as returned by `ensure_root`.

        Used when the user deletes a project and asks for its cloud copy to go
        too. Deleting a folder that is already gone is not an error. Providers
        with a recycle bin must use it and report ``recoverable_root_deletion``.
        Not abstract: a backend that cannot do it keeps working without it.
        """
        raise CloudError(
            f"{self.display_name or self.id or 'This backend'} cannot delete a project folder."
        )

    # -- optional hooks --------------------------------------------------------

    def about(self) -> dict:
        """Free-form account information for the UI (quota, user). Optional."""
        return {}

    def close(self) -> None:
        """Release sockets/handles. Called when a project is unloaded."""

    # -- shared conveniences ---------------------------------------------------

    def checksum_for(self, local_path: str) -> Optional[str]:
        """Hash a local file in this provider's checksum algorithm, if it has one."""
        algorithm = self.capabilities().checksum_algorithm
        if not algorithm:
            return None
        return hash_file(local_path, algorithm)

    @staticmethod
    def _iter_parents(rel_path: str) -> Iterable[str]:
        """Yield each ancestor directory of `rel_path`, outermost first."""
        parts = normalize_rel_path(rel_path).split("/")[:-1]
        for index in range(1, len(parts) + 1):
            yield "/".join(parts[:index])
