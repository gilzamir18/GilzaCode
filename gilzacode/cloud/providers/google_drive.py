"""Google Drive backend for the cloud facade.

Implemented directly against the Drive v3 REST API over the standard library.
The official client library would pull a large transitive dependency tree
(``google-api-python-client``, ``googleapis-common-protos``, ``httplib2``, …)
into a packaged desktop build, and its dynamic discovery is a recurring source
of PyInstaller failures, for what amounts to five endpoints.

Scope
-----
Only ``drive.file`` is requested: per-file access limited to what this
application creates or the user explicitly opens with it. Google classifies it
as non-sensitive, so it needs neither the verification review nor the annual
third-party security assessment that the full ``drive`` scope triggers. It is
also sufficient for the feature — the app only ever touches its own folder.

Drive concepts that do not cross the facade
-------------------------------------------
Drive addresses content by opaque file id and allows several files with the same
name in one folder; it has no notion of a path. This module keeps a path -> id
index internally and exposes only project-relative paths, which is what lets the
sync engine stay backend-neutral.
"""

from __future__ import annotations

import json
import mimetypes
import os
import stat as stat_module
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Iterable, Optional

from .. import oauth, transport
from ..atomic import discard_file, replace_file
from ..base import (
    AuthChallenge,
    AuthState,
    Capabilities,
    CloudAuthError,
    CloudError,
    CloudNotFound,
    CloudQuotaExceeded,
    CloudRootMissing,
    CloudStorageProvider,
    CloudTransientError,
    RemoteEntry,
    RemoteProject,
    normalize_rel_path,
)

AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke"
API_BASE = "https://www.googleapis.com/drive/v3"
UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files"

SCOPES = ["https://www.googleapis.com/auth/drive.file"]

FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"

# Container folder created in the account's Drive root, so several synced
# projects group together instead of scattering across the user's Drive.
CONTAINER_FOLDER = "GilzaCode"

# Credentials injected into a build by scripts/embed_google_client.py. Absent
# from the source tree (and from .gitignore'd working copies), which is why
# every read of it tolerates the file not existing.
BUNDLED_CLIENT_FILENAME = "bundled_google_client.json"

# Google's documented ceiling for a multipart upload. Anything larger goes
# through the resumable endpoint, which also lets the body stream from disk
# instead of being read into memory.
MULTIPART_LIMIT = 5 * 1024 * 1024

# Drive rejects single files above 5 TB; the practical limit is the account's
# quota, which the API reports separately.
MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024 * 1024

_FILE_FIELDS = "id,name,mimeType,size,md5Checksum,modifiedTime,version,trashed"
_LIST_FIELDS = f"nextPageToken,files({_FILE_FIELDS})"

_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_MAX_ATTEMPTS = 5


def unavailable_reason() -> str:
    """Report why this backend cannot be used, or "" when it can.

    Always usable: the implementation is stdlib-only, so nothing can be missing
    at import time. Absent client credentials are a configuration state the UI
    walks the user through, not an unavailable backend.
    """
    return ""


# Reached only by an installation that carries no bundled client. Connecting is
# meant to be one click, so this text names the real cause — the install is
# incomplete — instead of handing the user a Google Cloud console chore as if
# registering credentials were a normal step. It has been the wrong shape once
# already: a packaging rule dropped the client from every installed build, and
# this message sent users to the console to work around a broken package.
_MISSING_CLIENT_MESSAGE = (
    "This installation of GilzaCode was packaged without its Google OAuth client, "
    "so it cannot open the Google sign-in. Update or reinstall GilzaCode to a "
    "build that carries one. (Advanced: you can register a 'Desktop app' client "
    "of your own under Cloud sync -> Account.)"
)


# ─── Client credentials ───────────────────────────────────────────────────────

def _config_dir() -> str:
    from gilzacode.paths import gilzacode_home

    return os.path.join(str(gilzacode_home()), "cloud")


def client_config_path() -> str:
    """Where a user-supplied OAuth client override is stored."""
    return os.path.join(_config_dir(), "google_client.json")


def bundled_client_path() -> str:
    """Where the client shipped with this build lives, if it was injected.

    The file sits inside the package so a PyInstaller build picks it up as
    package data and ``__file__`` resolves it under ``sys._MEIPASS`` unchanged.
    """
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), BUNDLED_CLIENT_FILENAME)


def token_path() -> str:
    return os.path.join(_config_dir(), "google_drive_token.json")


def _read_client_file(path: str) -> dict[str, str]:
    """Parse a client-credentials file, or return empty fields when unusable.

    Accepts a credentials file downloaded straight from the Google Cloud
    console, which nests the fields under "installed" or "web".
    """
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"client_id": "", "client_secret": ""}
    if not isinstance(raw, dict):
        return {"client_id": "", "client_secret": ""}
    nested = raw.get("installed") or raw.get("web")
    if isinstance(nested, dict):
        raw = nested
    return {
        "client_id": str(raw.get("client_id", "") or "").strip(),
        "client_secret": str(raw.get("client_secret", "") or "").strip(),
    }


def load_bundled_client_config() -> dict[str, str]:
    """The OAuth client injected into this build, or empty fields when none is."""
    return _read_client_file(bundled_client_path())


def load_user_client_config() -> dict[str, str]:
    """The OAuth client the user pasted into Settings, if any."""
    return _read_client_file(client_config_path())


def describe_client_config() -> dict[str, str]:
    """Resolve the effective OAuth client and say where it came from.

    Resolution order, most specific first:

    ``environment``
        ``GILZACODE_GDRIVE_CLIENT_ID``/``_SECRET``, for development and for a
        distribution that injects a client at run time.
    ``user``
        A client the user registered themselves and pasted into Settings. It
        wins over the bundled one so a user who wants their own Cloud project —
        their own quota, their own consent screen — gets it.
    ``bundled``
        The client shipped with this build. This is what makes the normal path
        one click: the user presses Connect and authorizes in the browser,
        without ever seeing a client id.

    A source only counts when it carries a client id; a half-written override
    falls through to the next one instead of breaking the connection.
    """
    env_id = os.environ.get("GILZACODE_GDRIVE_CLIENT_ID", "").strip()
    if env_id:
        return {
            "client_id": env_id,
            "client_secret": os.environ.get("GILZACODE_GDRIVE_CLIENT_SECRET", "").strip(),
            "source": "environment",
        }
    user = load_user_client_config()
    if user.get("client_id"):
        return {**user, "source": "user"}
    bundled = load_bundled_client_config()
    if bundled.get("client_id"):
        return {**bundled, "source": "bundled"}
    return {"client_id": "", "client_secret": "", "source": "none"}


def load_client_config() -> dict[str, str]:
    """The effective client credentials, without the source label."""
    resolved = describe_client_config()
    return {
        "client_id": resolved["client_id"],
        "client_secret": resolved["client_secret"],
    }


def save_client_config(client_id: str, client_secret: str) -> None:
    """Store a user-supplied client, which then takes precedence over the bundled one."""
    _write_private_json(
        client_config_path(),
        {"client_id": str(client_id or "").strip(), "client_secret": str(client_secret or "").strip()},
    )


def clear_client_config() -> None:
    """Drop the user-supplied client and fall back to whatever the build ships."""
    try:
        os.unlink(client_config_path())
    except FileNotFoundError:
        pass
    except OSError:
        raise


def _write_private_json(path: str, payload: dict) -> None:
    """Write JSON that only the current user can read.

    These files hold a refresh token and a client secret. The permissions are
    set on the temporary file *before* it is put in place, so the content is
    never readable by other local users, not even briefly.
    """
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory, prefix=".cred-", suffix=".tmp", delete=False
    )
    try:
        with handle:
            json.dump(payload, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(handle.name, stat_module.S_IRUSR | stat_module.S_IWUSR)
        except OSError:
            # Windows and some network filesystems ignore POSIX modes; the file
            # still lands in the user's profile directory.
            pass
        replace_file(handle.name, path)
    except BaseException:
        try:
            discard_file(handle.name)
        except OSError:
            pass
        raise


# ─── Token storage ────────────────────────────────────────────────────────────

@dataclass
class _Token:
    access_token: str = ""
    refresh_token: str = ""
    expires_at: float = 0.0
    scope: str = ""
    account: str = ""

    @property
    def expired(self) -> bool:
        # Refresh a minute early: a token that expires mid-upload would fail a
        # transfer that had already started.
        return not self.access_token or time.time() >= (self.expires_at - 60)


def _load_token() -> _Token:
    try:
        with open(token_path(), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return _Token()
    if not isinstance(raw, dict):
        return _Token()
    return _Token(
        access_token=str(raw.get("access_token", "") or ""),
        refresh_token=str(raw.get("refresh_token", "") or ""),
        expires_at=float(raw.get("expires_at", 0) or 0),
        scope=str(raw.get("scope", "") or ""),
        account=str(raw.get("account", "") or ""),
    )


def _save_token(token: _Token) -> None:
    _write_private_json(
        token_path(),
        {
            "access_token": token.access_token,
            "refresh_token": token.refresh_token,
            "expires_at": token.expires_at,
            "scope": token.scope,
            "account": token.account,
        },
    )


def _clear_token() -> None:
    try:
        os.unlink(token_path())
    except FileNotFoundError:
        pass
    except OSError:
        pass


# ─── Provider ─────────────────────────────────────────────────────────────────

@dataclass
class _Node:
    file_id: str
    mime_type: str
    size: int
    checksum: str
    modified_at: str
    version: str


class GoogleDriveProvider(CloudStorageProvider):
    id = "google_drive"
    display_name = "Google Drive"

    def __init__(self, client_id: str = "", client_secret: str = ""):
        configured = load_client_config()
        self.client_id = client_id or configured.get("client_id", "")
        self.client_secret = client_secret or configured.get("client_secret", "")
        self._token = _load_token()
        # path -> id indexes for the currently indexed root.
        self._indexed_root: str = ""
        self._files: dict[str, _Node] = {}
        self._folders: dict[str, str] = {}

    # -- capabilities ----------------------------------------------------------

    def capabilities(self) -> Capabilities:
        return Capabilities(
            checksum_algorithm="md5",
            # Drive v3 has no If-Match on file content updates, so a conditional
            # write cannot be expressed. The engine compensates by re-reading
            # the remote state when it detects a divergence.
            conditional_writes=False,
            max_file_size=MAX_FILE_SIZE,
            server_side_versioning=True,
            project_listing=True,
            # `delete_root` moves the folder to the Drive trash.
            recoverable_root_deletion=True,
        )

    # -- authorization ---------------------------------------------------------

    def auth_status(self) -> AuthState:
        if not self.client_id:
            return AuthState(connected=False, error=_MISSING_CLIENT_MESSAGE)
        token = self._token
        if not token.refresh_token and not token.access_token:
            return AuthState(connected=False)
        if token.expired and not token.refresh_token:
            return AuthState(connected=False, error="The stored authorization expired.")
        return AuthState(
            connected=True,
            account=token.account,
            scopes=token.scope.split() if token.scope else list(SCOPES),
        )

    def begin_authorization(self) -> AuthChallenge:
        if not self.client_id:
            raise CloudAuthError(_MISSING_CLIENT_MESSAGE)
        url, session = oauth.start_authorization(
            authorization_endpoint=AUTHORIZATION_ENDPOINT,
            client_id=self.client_id,
            scopes=SCOPES,
            extra_params={
                # Without offline access Google returns no refresh token and the
                # connection would break an hour later.
                "access_type": "offline",
                # Google only re-issues a refresh token when consent is shown
                # again; without this a user who reconnects gets an access token
                # that cannot be renewed.
                "prompt": "consent",
                "include_granted_scopes": "true",
            },
        )
        opened = oauth.open_in_browser(url)
        instructions = (
            "Complete the authorization in your browser, then return to GilzaCode."
            if opened
            else "Open this URL in your browser to authorize GilzaCode:"
        )
        return AuthChallenge(authorization_url=url, session=session, instructions=instructions)

    def complete_authorization(self, session: dict, response: Optional[dict] = None) -> AuthState:
        payload = oauth.finish_authorization(
            session,
            token_endpoint=TOKEN_ENDPOINT,
            client_id=self.client_id,
            client_secret=self.client_secret,
            response=response,
        )
        refresh_token = str(payload.get("refresh_token", "") or "")
        if not refresh_token:
            raise CloudAuthError(
                "Google did not return a refresh token. Remove GilzaCode from your "
                "account's third-party access list and connect again."
            )
        self._token = _Token(
            access_token=str(payload.get("access_token", "") or ""),
            refresh_token=refresh_token,
            expires_at=time.time() + float(payload.get("expires_in", 0) or 0),
            scope=str(payload.get("scope", "") or " ".join(SCOPES)),
        )
        self._token.account = self._fetch_account_email()
        _save_token(self._token)
        return self.auth_status()

    def cancel_authorization(self, session: dict) -> None:
        oauth.cancel_authorization(session)

    def revoke(self) -> None:
        token = self._token
        if token.refresh_token or token.access_token:
            oauth.revoke_token(REVOCATION_ENDPOINT, token.refresh_token or token.access_token)
        self._token = _Token()
        _clear_token()
        self._reset_index()

    def _fetch_account_email(self) -> str:
        try:
            about = self._api_json("GET", f"{API_BASE}/about", params={"fields": "user(emailAddress)"})
        except CloudError:
            # The account label is cosmetic; a failure here must not undo an
            # otherwise successful authorization.
            return ""
        user = about.get("user") or {}
        return str(user.get("emailAddress", "") or "")

    # -- remote workspace ------------------------------------------------------

    def ensure_root(self, folder_name: str, existing_root: str = "") -> str:
        if existing_root:
            # Only a definite answer counts as "gone": a 404, or the folder in
            # the trash. A network failure propagates as itself, so it cannot
            # be read as a deletion.
            try:
                item = self._api_json(
                    "GET", f"{API_BASE}/files/{existing_root}", params={"fields": _FILE_FIELDS}
                )
            except CloudNotFound:
                item = None
            if not item or item.get("trashed") or item.get("mimeType") != FOLDER_MIME:
                # Re-creating it here used to look helpful, and it wiped other
                # machines: their baseline against a new, empty folder reads as
                # "every file was deleted in the cloud". See CloudRootMissing.
                raise CloudRootMissing(
                    "This project's folder is no longer in Google Drive — it was deleted, "
                    "moved to the trash, or belongs to a different Google account."
                )
            if existing_root != self._indexed_root:
                self._reset_index()
            return existing_root
        container = self._ensure_folder(_safe_name(CONTAINER_FOLDER), parent="root")
        root = self._ensure_folder(_safe_name(folder_name), parent=container)
        if root != self._indexed_root:
            self._reset_index()
        return root

    def list_projects(self) -> list[RemoteProject]:
        """Every project folder inside the account's GilzaCode container.

        Read-only by contract: the container is *looked up*, never created, so
        asking an account that has never synced anything answers "nothing here"
        instead of leaving an empty folder behind in the user's Drive.
        """
        container = self._find_folder(_safe_name(CONTAINER_FOLDER), parent="root")
        if not container:
            return []
        projects: list[RemoteProject] = []
        for item in self._list_children(container):
            if str(item.get("mimeType", "")) != FOLDER_MIME:
                continue
            name = str(item.get("name", ""))
            file_id = str(item.get("id", ""))
            if not name or not file_id:
                continue
            projects.append(
                RemoteProject(
                    name=name,
                    root=file_id,
                    modified_at=str(item.get("modifiedTime", "") or ""),
                )
            )
        projects.sort(key=lambda project: project.name.lower())
        return projects

    def list_entries(self, root: str) -> list[RemoteEntry]:
        self._build_index(root)
        entries: list[RemoteEntry] = []
        for rel_path, node in self._files.items():
            entries.append(
                RemoteEntry(
                    rel_path=rel_path,
                    remote_rev=_revision(node),
                    size=node.size,
                    modified_at=node.modified_at,
                    checksum=node.checksum or None,
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
        rel_path = normalize_rel_path(rel_path)
        self._ensure_index(root)
        size = os.path.getsize(local_path)
        existing = self._files.get(rel_path)

        if existing is not None:
            node = self._update_content(existing.file_id, local_path, size)
        else:
            parent = self._ensure_folder_path(root, _parent_of(rel_path))
            node = self._create_file(parent, _name_of(rel_path), local_path, size)

        self._files[rel_path] = node
        return RemoteEntry(
            rel_path=rel_path,
            remote_rev=_revision(node),
            size=node.size,
            modified_at=node.modified_at,
            checksum=node.checksum or None,
        )

    def download(self, root: str, rel_path: str, dest_path: str) -> RemoteEntry:
        rel_path = normalize_rel_path(rel_path)
        self._ensure_index(root)
        node = self._files.get(rel_path)
        if node is None:
            raise CloudError(f"Remote file not found: {rel_path}")

        directory = os.path.dirname(os.path.abspath(dest_path)) or "."
        os.makedirs(directory, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(
            dir=directory, prefix=".sync-", suffix=".tmp", delete=False
        )
        try:
            with handle:
                self._api_stream_to(
                    f"{API_BASE}/files/{node.file_id}", {"alt": "media"}, handle
                )
                handle.flush()
                os.fsync(handle.fileno())
            replace_file(handle.name, dest_path)
        except BaseException:
            try:
                discard_file(handle.name)
            except OSError:
                pass
            raise

        return RemoteEntry(
            rel_path=rel_path,
            remote_rev=_revision(node),
            size=node.size,
            modified_at=node.modified_at,
            checksum=node.checksum or None,
        )

    def delete(self, root: str, rel_path: str, expected_rev: Optional[str] = None) -> None:
        rel_path = normalize_rel_path(rel_path)
        self._ensure_index(root)
        node = self._files.get(rel_path)
        if node is None:
            return
        # Trash rather than delete permanently: a bug in the reconciliation must
        # never be able to destroy the user's only remaining copy.
        self._api_json(
            "PATCH",
            f"{API_BASE}/files/{node.file_id}",
            params={"fields": "id"},
            body={"trashed": True},
        )
        self._files.pop(rel_path, None)

    def delete_root(self, root: str) -> None:
        # Trashed, never deleted permanently, for the same reason `delete` does:
        # the user can still restore it from Drive for about 30 days.
        try:
            self._api_json(
                "PATCH",
                f"{API_BASE}/files/{root}",
                params={"fields": "id"},
                body={"trashed": True},
            )
        except CloudNotFound:
            pass
        if root == self._indexed_root:
            self._reset_index()

    def about(self) -> dict:
        try:
            data = self._api_json(
                "GET", f"{API_BASE}/about", params={"fields": "user(emailAddress,displayName),storageQuota"}
            )
        except CloudError as exc:
            return {"provider": self.id, "error": str(exc)}
        user = data.get("user") or {}
        quota = data.get("storageQuota") or {}
        return {
            "provider": self.id,
            "account": user.get("emailAddress", ""),
            "display_name": user.get("displayName", ""),
            "used_bytes": int(quota.get("usage", 0) or 0),
            "total_bytes": int(quota.get("limit", 0) or 0),
        }

    # -- index -----------------------------------------------------------------

    def _reset_index(self) -> None:
        self._indexed_root = ""
        self._files = {}
        self._folders = {}

    def _ensure_index(self, root: str) -> None:
        if self._indexed_root != root:
            self._build_index(root)

    def _build_index(self, root: str) -> None:
        """Walk the remote folder tree, building the path -> id maps."""
        files: dict[str, _Node] = {}
        folders: dict[str, str] = {"": root}
        pending: list[tuple[str, str]] = [("", root)]

        while pending:
            prefix, folder_id = pending.pop()
            for item in self._list_children(folder_id):
                name = str(item.get("name", ""))
                if not name or name in {".", ".."} or "/" in name:
                    # Drive permits characters a path cannot represent. Such an
                    # entry has no project-relative address, so it is left alone
                    # rather than mapped onto some other file's path.
                    continue
                rel_path = f"{prefix}/{name}" if prefix else name
                mime = str(item.get("mimeType", ""))
                if mime == FOLDER_MIME:
                    folder_id_child = str(item.get("id", ""))
                    if rel_path in folders:
                        continue
                    folders[rel_path] = folder_id_child
                    pending.append((rel_path, folder_id_child))
                    continue
                if mime == SHORTCUT_MIME or mime.startswith("application/vnd.google-apps."):
                    # Shortcuts and native Google documents have no byte stream
                    # to mirror.
                    continue
                node = _node_from(item)
                previous = files.get(rel_path)
                if previous is not None:
                    # Drive allows duplicate names in one folder; a path can only
                    # address one file. Keep the most recently modified and leave
                    # the rest untouched, reporting it so the collision is not
                    # silent.
                    if previous.modified_at >= node.modified_at:
                        continue
                    print(
                        f"[gilzacode.cloud] Google Drive holds more than one file named "
                        f"{rel_path!r}; syncing the most recently modified one.",
                        file=sys.stderr,
                    )
                files[rel_path] = node

        self._indexed_root = root
        self._files = files
        self._folders = folders

    def _list_children(self, folder_id: str) -> Iterable[dict]:
        page_token = ""
        while True:
            params = {
                "q": f"{_quote_id(folder_id)} in parents and trashed = false",
                "fields": _LIST_FIELDS,
                "pageSize": "1000",
                "spaces": "drive",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if page_token:
                params["pageToken"] = page_token
            payload = self._api_json("GET", f"{API_BASE}/files", params=params)
            for item in payload.get("files", []) or []:
                yield item
            page_token = str(payload.get("nextPageToken", "") or "")
            if not page_token:
                return

    def _get_file(self, file_id: str) -> Optional[_Node]:
        try:
            item = self._api_json(
                "GET", f"{API_BASE}/files/{file_id}", params={"fields": _FILE_FIELDS}
            )
        except CloudError:
            return None
        if item.get("trashed"):
            return None
        return _node_from(item)

    def _find_folder(self, name: str, parent: str) -> str:
        """Id of the folder named `name` under `parent`, or "" when there is none."""
        query = (
            f"name = {_quote(name)} and {_quote_id(parent)} in parents "
            f"and mimeType = {_quote(FOLDER_MIME)} and trashed = false"
        )
        payload = self._api_json(
            "GET",
            f"{API_BASE}/files",
            params={"q": query, "fields": "files(id,modifiedTime)", "pageSize": "10"},
        )
        found = payload.get("files") or []
        if not found:
            return ""
        # Deterministic pick when the user has several folders of the same
        # name: the oldest, so the choice does not change between runs.
        found.sort(key=lambda item: str(item.get("modifiedTime", "")))
        return str(found[0]["id"])

    def _ensure_folder(self, name: str, parent: str) -> str:
        existing = self._find_folder(name, parent)
        if existing:
            return existing
        created = self._api_json(
            "POST",
            f"{API_BASE}/files",
            params={"fields": "id"},
            body={"name": name, "mimeType": FOLDER_MIME, "parents": [parent]},
        )
        return str(created["id"])

    def _ensure_folder_path(self, root: str, rel_dir: str) -> str:
        if not rel_dir:
            return root
        parent = root
        walked = ""
        for segment in rel_dir.split("/"):
            walked = f"{walked}/{segment}" if walked else segment
            known = self._folders.get(walked)
            if known:
                parent = known
                continue
            parent = self._ensure_folder(_safe_name(segment), parent)
            self._folders[walked] = parent
        return parent

    # -- content transfer ------------------------------------------------------

    def _create_file(self, parent: str, name: str, local_path: str, size: int) -> _Node:
        metadata = {"name": name, "parents": [parent]}
        mime = _guess_mime(local_path)
        if size <= MULTIPART_LIMIT:
            with open(local_path, "rb") as handle:
                content = handle.read()
            body, content_type = _multipart_body(metadata, content, mime)
            item = self._api_json(
                "POST",
                UPLOAD_BASE,
                params={"uploadType": "multipart", "fields": _FILE_FIELDS},
                raw_body=body,
                content_type=content_type,
            )
            return _node_from(item)
        return self._resumable_upload(
            "POST",
            UPLOAD_BASE,
            {"uploadType": "resumable", "fields": _FILE_FIELDS},
            metadata,
            local_path,
            size,
            mime,
        )

    def _update_content(self, file_id: str, local_path: str, size: int) -> _Node:
        mime = _guess_mime(local_path)
        if size <= MULTIPART_LIMIT:
            with open(local_path, "rb") as handle:
                content = handle.read()
            item = self._api_json(
                "PATCH",
                f"{UPLOAD_BASE}/{file_id}",
                params={"uploadType": "media", "fields": _FILE_FIELDS},
                raw_body=content,
                content_type=mime,
            )
            return _node_from(item)
        return self._resumable_upload(
            "PATCH",
            f"{UPLOAD_BASE}/{file_id}",
            {"uploadType": "resumable", "fields": _FILE_FIELDS},
            {},
            local_path,
            size,
            mime,
        )

    def _resumable_upload(
        self,
        method: str,
        url: str,
        params: dict[str, str],
        metadata: dict,
        local_path: str,
        size: int,
        mime: str,
    ) -> _Node:
        """Two-step upload: negotiate a session, then stream the body to it.

        The body is streamed from the open file rather than read into memory, so
        a large PDF does not have to fit in RAM alongside the rest of the app.
        """
        session_response = self._request(
            method,
            url,
            params=params,
            body=json.dumps(metadata).encode("utf-8") if metadata else b"{}",
            content_type="application/json; charset=UTF-8",
            extra_headers={
                "X-Upload-Content-Type": mime,
                "X-Upload-Content-Length": str(size),
            },
            expect_json=False,
        )
        location = session_response.headers.get("Location", "")
        if not location:
            raise CloudError("Google Drive did not return an upload session URL.")

        with open(local_path, "rb") as handle:
            response = self._request(
                "PUT",
                location,
                body=handle,
                content_type=mime,
                extra_headers={"Content-Length": str(size)},
                body_length=size,
            )
        return _node_from(response.json)

    # -- HTTP plumbing ---------------------------------------------------------

    def _access_token(self) -> str:
        token = self._token
        if not token.expired:
            return token.access_token
        if not token.refresh_token:
            raise CloudAuthError("Google Drive is not connected.")
        if not self.client_id:
            raise CloudAuthError(_MISSING_CLIENT_MESSAGE)
        payload = oauth.refresh_access_token(
            token_endpoint=TOKEN_ENDPOINT,
            client_id=self.client_id,
            client_secret=self.client_secret,
            refresh_token=token.refresh_token,
        )
        token.access_token = str(payload.get("access_token", "") or "")
        token.expires_at = time.time() + float(payload.get("expires_in", 0) or 0)
        # Google usually omits refresh_token on renewal; keep the stored one.
        if payload.get("refresh_token"):
            token.refresh_token = str(payload["refresh_token"])
        _save_token(token)
        return token.access_token

    def _api_json(
        self,
        method: str,
        url: str,
        params: Optional[dict[str, str]] = None,
        body: Optional[dict] = None,
        raw_body: Optional[bytes] = None,
        content_type: str = "application/json; charset=UTF-8",
    ) -> dict:
        payload = raw_body
        if payload is None and body is not None:
            payload = json.dumps(body).encode("utf-8")
        response = self._request(
            method, url, params=params, body=payload, content_type=content_type
        )
        return response.json

    def _api_stream_to(self, url: str, params: dict[str, str], destination) -> None:
        response = self._request("GET", url, params=params, stream_to=destination)
        del response

    def _request(
        self,
        method: str,
        url: str,
        params: Optional[dict[str, str]] = None,
        body=None,
        content_type: str = "",
        extra_headers: Optional[dict[str, str]] = None,
        stream_to=None,
        expect_json: bool = True,
        body_length: Optional[int] = None,
    ) -> "_Response":
        """Issue one Drive API call, retrying the failures worth retrying.

        A streamed body (an open file) can only be sent once, so a retry rewinds
        it; when it cannot be rewound the call fails instead of sending a
        truncated upload.
        """
        target = url
        if params:
            target = f"{url}?{urllib.parse.urlencode(params)}"

        last_error: Optional[Exception] = None
        for attempt in range(_MAX_ATTEMPTS):
            if hasattr(body, "seek"):
                try:
                    body.seek(0)
                except (OSError, ValueError) as exc:
                    raise CloudError("Upload body cannot be retried.") from exc

            headers = {
                "Authorization": f"Bearer {self._access_token()}",
                "Accept": "application/json",
            }
            if content_type:
                headers["Content-Type"] = content_type
            if body_length is not None:
                headers["Content-Length"] = str(body_length)
            headers.update(extra_headers or {})

            request = urllib.request.Request(target, data=body, method=method, headers=headers)
            try:
                with transport.urlopen(request, timeout=120) as raw:
                    if stream_to is not None:
                        _copy_stream(raw, stream_to)
                        return _Response(raw.status, dict(raw.headers), {})
                    payload = raw.read()
                    parsed: dict = {}
                    if expect_json and payload:
                        try:
                            parsed = json.loads(payload.decode("utf-8"))
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            parsed = {}
                    return _Response(raw.status, dict(raw.headers), parsed)
            except urllib.error.HTTPError as exc:
                detail = _error_detail(exc)
                if exc.code == 401:
                    # The access token was rejected. Force a refresh and retry
                    # once; a genuinely revoked grant fails again at refresh
                    # time with a clear auth error.
                    self._token.expires_at = 0.0
                    last_error = CloudAuthError(detail)
                    if attempt == 0:
                        continue
                    raise CloudAuthError(f"Google Drive rejected the credentials: {detail}")
                if exc.code == 403 and _is_quota_error(detail):
                    raise CloudQuotaExceeded(f"Google Drive storage quota exceeded: {detail}")
                if exc.code in _RETRY_STATUSES or (exc.code == 403 and _is_rate_limit(detail)):
                    last_error = CloudTransientError(f"Drive API {exc.code}: {detail}")
                    _backoff(attempt)
                    continue
                if exc.code == 404:
                    raise CloudNotFound(f"Not found: {detail}")
                raise CloudError(f"Drive API {exc.code}: {detail}")
            except urllib.error.URLError as exc:
                last_error = CloudTransientError(f"Network error: {exc.reason}")
                _backoff(attempt)
                continue
            except TimeoutError as exc:
                last_error = CloudTransientError(f"Request timed out: {exc}")
                _backoff(attempt)
                continue

        raise last_error or CloudTransientError("Drive request failed.")


@dataclass
class _Response:
    status: int
    headers: dict[str, str]
    json: dict


# ─── Module helpers ───────────────────────────────────────────────────────────

def _node_from(item: dict) -> _Node:
    return _Node(
        file_id=str(item.get("id", "")),
        mime_type=str(item.get("mimeType", "")),
        size=int(item.get("size", 0) or 0),
        checksum=str(item.get("md5Checksum", "") or ""),
        modified_at=str(item.get("modifiedTime", "") or ""),
        version=str(item.get("version", "") or ""),
    )


def _revision(node: _Node) -> str:
    """Opaque revision for a Drive file.

    The content checksum is preferred over Drive's ``version`` counter because
    ``version`` also increments on metadata-only changes — renaming a file or
    sharing it would otherwise look like an edit and trigger a pointless
    download on every other machine.
    """
    if node.checksum:
        return f"md5:{node.checksum}"
    return f"v:{node.version}"


def _parent_of(rel_path: str) -> str:
    return rel_path.rsplit("/", 1)[0] if "/" in rel_path else ""


def _name_of(rel_path: str) -> str:
    return rel_path.rsplit("/", 1)[-1]


def _safe_name(name: str) -> str:
    cleaned = str(name or "").replace("/", "-").strip()
    return cleaned or "project"


def _quote(value: str) -> str:
    """Quote a literal for a Drive `q` query (Drive escapes with backslashes)."""
    escaped = str(value).replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def _quote_id(file_id: str) -> str:
    return _quote(file_id)


def _guess_mime(path: str) -> str:
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def _multipart_body(metadata: dict, content: bytes, mime: str) -> tuple[bytes, str]:
    boundary = f"gilzacode-{os.urandom(16).hex()}"
    parts = [
        f"--{boundary}\r\n".encode("utf-8"),
        b"Content-Type: application/json; charset=UTF-8\r\n\r\n",
        json.dumps(metadata).encode("utf-8"),
        f"\r\n--{boundary}\r\n".encode("utf-8"),
        f"Content-Type: {mime}\r\n\r\n".encode("utf-8"),
        content,
        f"\r\n--{boundary}--\r\n".encode("utf-8"),
    ]
    return b"".join(parts), f"multipart/related; boundary={boundary}"


def _copy_stream(source, destination, chunk_size: int = 1024 * 256) -> None:
    while True:
        chunk = source.read(chunk_size)
        if not chunk:
            return
        destination.write(chunk)


def _error_detail(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", "replace")
    except Exception:
        return exc.reason or str(exc.code)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw[:400]
    error = parsed.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error.get("status") or raw[:400])
    return str(error or raw[:400])


def _is_rate_limit(detail: str) -> bool:
    lowered = detail.lower()
    return "rate limit" in lowered or "userratelimitexceeded" in lowered or "ratelimitexceeded" in lowered


def _is_quota_error(detail: str) -> bool:
    lowered = detail.lower()
    return "quota" in lowered and "rate" not in lowered


def _backoff(attempt: int) -> None:
    # Exponential with a small deterministic jitter derived from the attempt, so
    # several parallel projects do not retry in lockstep.
    delay = min(2.0 ** attempt, 16.0) + (os.getpid() % 100) / 1000.0
    time.sleep(delay)
