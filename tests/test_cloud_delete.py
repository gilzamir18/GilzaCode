"""Deleting a project together with its copy in the cloud.

The copy is shared: other computers may still mirror the same folder. Deleting
it must therefore be safe *for them* — their next pass has to stop with their
files intact, instead of reading the vanished folder as "every file was deleted
in the cloud" and deleting the working copy.

Everything except the Drive-specific tests runs against `local_folder`, the same
real provider the contract suite uses.
"""

import os

import pytest

from gilzacode.cloud import service
from gilzacode.cloud.base import CloudError, CloudNotFound, CloudRootMissing, CloudTransientError
from gilzacode.cloud.engine import SyncEngine
from gilzacode.cloud.providers import google_drive
from gilzacode.cloud.providers.local_folder import LocalFolderProvider
from gilzacode.cloud.state import (
    CloudSettings,
    CloudState,
    load_state,
    reset_baseline,
    save_settings,
)
from gilzacode import projects


# ─── Fixtures & helpers ───────────────────────────────────────────────────────

@pytest.fixture
def remote_base(tmp_path):
    path = tmp_path / "remote"
    path.mkdir()
    return str(path)


def write(root, rel_path, content):
    absolute = os.path.join(root, rel_path.replace("/", os.sep))
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    with open(absolute, "w", encoding="utf-8") as handle:
        handle.write(content)
    return absolute


def mirrored_project(tmp_path, remote_base, machine="machine-a", files=None):
    """A small project already pushed to the shared remote once."""
    project = str(tmp_path / machine / "thesis")
    for rel_path, content in (files or {"main.tex": "body", "refs.bib": "@book{}"}).items():
        write(project, rel_path, content)
    save_settings(project, CloudSettings(
        enabled=True,
        provider="local_folder",
        remote_folder="thesis",
        provider_config={"base_dir": remote_base},
    ))
    outcome = service.sync_project("thesis", project, provider=LocalFolderProvider(remote_base))
    assert outcome.report.ok, outcome.error
    return project


def clone_to(tmp_path, remote_base, machine="machine-b"):
    destination = str(tmp_path / machine / "thesis")
    outcome = service.clone_project(
        "local_folder", "thesis", destination,
        provider_config={"base_dir": remote_base},
    )
    assert outcome.ok, outcome.error
    return destination


def files_in(root):
    found = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".gilzacode"]
        for name in filenames:
            found.add(os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/"))
    return found


# ─── A vanished folder stops the pass instead of wiping the working copy ─────

def test_a_missing_root_is_reported_not_recreated(remote_base, tmp_path):
    provider = LocalFolderProvider(remote_base)
    root = provider.ensure_root("thesis")
    os.rmdir(root)

    with pytest.raises(CloudRootMissing):
        provider.ensure_root("thesis", existing_root=root)
    assert not os.path.exists(root)


def test_another_machine_keeps_its_files_when_the_cloud_copy_is_deleted(remote_base, tmp_path):
    machine_a = mirrored_project(tmp_path, remote_base)
    machine_b = clone_to(tmp_path, remote_base)
    before = files_in(machine_b)
    assert {"main.tex", "refs.bib"} <= before

    service.delete_remote_project(machine_a)
    # Fewer than BULK_DELETE_MIN files: the bulk-delete guard would not have
    # stopped this. Only the missing-root check does.
    outcome = service.sync_project("thesis", machine_b, provider=LocalFolderProvider(remote_base))

    assert outcome.report.remote_missing
    assert not outcome.report.ok
    assert "no local file was touched" in outcome.report.aborted
    assert files_in(machine_b) == before
    # ...and nothing was re-created in the account behind the user's back.
    assert not os.path.exists(os.path.join(remote_base, "thesis"))


def test_publishing_again_after_a_missing_root_uploads_a_fresh_copy(remote_base, tmp_path):
    machine_a = mirrored_project(tmp_path, remote_base)
    machine_b = clone_to(tmp_path, remote_base)
    service.delete_remote_project(machine_a)
    service.sync_project("thesis", machine_b, provider=LocalFolderProvider(remote_base))

    reset_baseline(machine_b)
    outcome = service.sync_project("thesis", machine_b, provider=LocalFolderProvider(remote_base))

    assert outcome.report.ok
    assert {"main.tex", "refs.bib"} <= set(outcome.report.uploaded)
    assert os.path.isfile(os.path.join(remote_base, "thesis", "main.tex"))


# ─── Deleting the cloud copy ──────────────────────────────────────────────────

def test_the_link_reports_nothing_before_the_first_pass(remote_base, tmp_path):
    project = str(tmp_path / "fresh")
    os.makedirs(project)
    save_settings(project, CloudSettings(
        enabled=True, provider="local_folder", provider_config={"base_dir": remote_base},
    ))

    assert service.cloud_link(project)["linked"] is False


def test_the_link_names_the_folder_and_says_whether_it_is_recoverable(remote_base, tmp_path):
    project = mirrored_project(tmp_path, remote_base)

    link = service.cloud_link(project)

    assert link["linked"] is True
    assert link["remote_folder"] == "thesis"
    assert link["provider_name"] == "Local folder"
    # A plain directory has no trash.
    assert link["recoverable"] is False


def test_deleting_the_cloud_copy_removes_the_folder_and_unlinks_this_machine(remote_base, tmp_path):
    project = mirrored_project(tmp_path, remote_base)

    result = service.delete_remote_project(project)

    assert result["deleted"] is True
    assert not os.path.exists(os.path.join(remote_base, "thesis"))
    assert os.path.isfile(os.path.join(project, "main.tex"))
    state = load_state(project)
    assert state.root == "" and state.entries == {}


def test_deleting_a_project_that_never_synced_deletes_nothing(remote_base, tmp_path):
    other = mirrored_project(tmp_path, remote_base)
    project = str(tmp_path / "fresh")
    os.makedirs(project)
    save_settings(project, CloudSettings(
        enabled=True, provider="local_folder", provider_config={"base_dir": remote_base},
    ))

    result = service.delete_remote_project(project)

    assert result["deleted"] is False
    assert os.path.isdir(load_state(other).root)


def test_the_local_provider_refuses_to_delete_outside_its_mirror(remote_base, tmp_path):
    provider = LocalFolderProvider(remote_base)
    outside = tmp_path / "precious"
    outside.mkdir()

    with pytest.raises(CloudError):
        provider.delete_root(str(outside))
    with pytest.raises(CloudError):
        provider.delete_root(remote_base)
    assert outside.is_dir()


def test_the_manager_deletes_once_no_pass_holds_the_project(remote_base, tmp_path):
    project = mirrored_project(tmp_path, remote_base)
    manager = service.CloudSyncManager()

    result = manager.delete_remote_copy(project, provider=LocalFolderProvider(remote_base))

    assert result["deleted"] is True
    assert not os.path.exists(os.path.join(remote_base, "thesis"))


def test_the_manager_gives_up_when_a_pass_does_not_finish(remote_base, tmp_path):
    project = mirrored_project(tmp_path, remote_base)
    manager = service.CloudSyncManager()
    lock = manager._lock_for(project)
    lock.acquire()
    try:
        with pytest.raises(CloudError, match="still finishing"):
            manager.delete_remote_copy(project, wait_seconds=0.05)
    finally:
        lock.release()
    assert os.path.isdir(os.path.join(remote_base, "thesis"))


# ─── Google Drive ─────────────────────────────────────────────────────────────

@pytest.fixture
def drive(monkeypatch):
    monkeypatch.setattr(google_drive, "_load_token", lambda: google_drive._Token())
    monkeypatch.setattr(
        google_drive, "load_client_config", lambda: {"client_id": "id", "client_secret": "s"}
    )
    provider = google_drive.GoogleDriveProvider()
    calls = []

    def respond_with(handler):
        def fake(method, url, params=None, body=None, raw_body=None, content_type=""):
            calls.append((method, url, body))
            return handler(method, url, body)
        monkeypatch.setattr(provider, "_api_json", fake)

    provider.respond_with = respond_with
    provider.calls = calls
    return provider


def test_drive_reports_a_trashed_root_as_missing(drive):
    drive.respond_with(lambda *_: {
        "id": "root-1", "mimeType": google_drive.FOLDER_MIME, "trashed": True,
    })

    with pytest.raises(CloudRootMissing):
        drive.ensure_root("thesis", existing_root="root-1")
    # A lookup, and nothing created in its place.
    assert [method for method, _url, _body in drive.calls] == ["GET"]


def test_drive_reports_a_deleted_root_as_missing(drive):
    def gone(*_):
        raise CloudNotFound("Not found: root-1")
    drive.respond_with(gone)

    with pytest.raises(CloudRootMissing):
        drive.ensure_root("thesis", existing_root="root-1")


def test_drive_does_not_read_a_network_failure_as_a_deletion(drive):
    def offline(*_):
        raise CloudTransientError("Network error: unreachable")
    drive.respond_with(offline)

    with pytest.raises(CloudTransientError):
        drive.ensure_root("thesis", existing_root="root-1")


def test_drive_reuses_a_root_that_still_exists(drive):
    drive.respond_with(lambda *_: {
        "id": "root-1", "mimeType": google_drive.FOLDER_MIME, "trashed": False,
    })

    assert drive.ensure_root("thesis", existing_root="root-1") == "root-1"


def test_drive_moves_a_deleted_project_to_the_trash(drive):
    drive.respond_with(lambda *_: {"id": "root-1"})

    drive.delete_root("root-1")

    assert drive.calls == [("PATCH", f"{google_drive.API_BASE}/files/root-1", {"trashed": True})]
    assert drive.capabilities().recoverable_root_deletion is True


def test_drive_treats_an_already_deleted_project_as_done(drive):
    def gone(*_):
        raise CloudNotFound("Not found: root-1")
    drive.respond_with(gone)

    drive.delete_root("root-1")


# ─── The endpoints ────────────────────────────────────────────────────────────

def registered(tmp_path, remote_base):
    project = mirrored_project(tmp_path, remote_base)
    return project, projects.add("thesis", project, must_exist=True).name


async def test_the_link_endpoint_reads_local_state(client, tmp_path, remote_base):
    project = mirrored_project(tmp_path, remote_base)

    response = await client.get("/api/cloud/link", params={"projectPath": project})

    payload = await response.json()
    assert response.status == 200, payload
    assert payload["linked"] is True


async def test_deleting_a_project_can_delete_its_cloud_copy(client, tmp_path, remote_base):
    project, name = registered(tmp_path, remote_base)

    response = await client.post("/api/projects/delete", json={
        "name": name, "delete_dir": False, "delete_cloud": True,
    })

    payload = await response.json()
    assert response.status == 200, payload
    assert payload["cloud"]["deleted"] is True
    assert not os.path.exists(os.path.join(remote_base, "thesis"))
    assert projects.get(name) is None
    # The directory was not asked to go, so it stays.
    assert os.path.isfile(os.path.join(project, "main.tex"))


async def test_deleting_a_project_leaves_the_cloud_copy_unless_asked(client, tmp_path, remote_base):
    _project, name = registered(tmp_path, remote_base)

    response = await client.post("/api/projects/delete", json={"name": name, "delete_dir": False})

    payload = await response.json()
    assert response.status == 200, payload
    assert payload["cloud"] is None
    assert os.path.isfile(os.path.join(remote_base, "thesis", "main.tex"))


async def test_a_failed_cloud_deletion_removes_nothing(client, tmp_path, remote_base, monkeypatch):
    project, name = registered(tmp_path, remote_base)

    def refuse(self, root):
        raise CloudError("storage unavailable")

    monkeypatch.setattr(LocalFolderProvider, "delete_root", refuse)

    response = await client.post("/api/projects/delete", json={
        "name": name, "delete_dir": True, "delete_cloud": True,
    })

    payload = await response.json()
    assert response.status == 400
    assert "nothing was removed" in payload["error"]
    assert projects.get(name) is not None
    assert os.path.isfile(os.path.join(project, "main.tex"))
    assert os.path.isfile(os.path.join(remote_base, "thesis", "main.tex"))
