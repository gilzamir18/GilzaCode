"""Stopping a sync or a download that is already under way.

A pass over a large project, or the download of one, can take minutes. The user
has to be able to stop it, and stopping must not leave anything inconsistent:
a cancelled sync keeps what it already moved (the next pass resumes from there),
and a cancelled download leaves no half-copy behind to be mistaken for a project.

Runs against `local_folder`, the same real provider the contract suite uses.
"""

import os

import pytest

from gilzacode.cloud import service
from gilzacode.cloud.engine import SyncEngine
from gilzacode.cloud.providers.local_folder import LocalFolderProvider
from gilzacode.cloud.state import CloudSettings, CloudState, load_state, save_settings
from gilzacode import projects


# ─── Fixtures & helpers ───────────────────────────────────────────────────────

@pytest.fixture
def project(tmp_path):
    path = tmp_path / "project"
    path.mkdir()
    return str(path)


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


def seed_remote(remote_base, folder, count):
    root = os.path.join(remote_base, folder)
    for index in range(count):
        write(root, f"file{index:02d}.tex", str(index))
    return root


class CancellingProvider(LocalFolderProvider):
    """Asks for a cancel from inside the pass, after `after` transfers.

    That is the moment a user's click lands in practice: while a file is moving.
    """

    def __init__(self, base_dir, cancel_path, after=1):
        super().__init__(base_dir)
        self.cancel_path = cancel_path
        self.after = after
        self.transfers = 0

    def _count(self):
        self.transfers += 1
        if self.transfers == self.after:
            assert service.request_cancel(self.cancel_path)

    def upload(self, *args, **kwargs):
        entry = super().upload(*args, **kwargs)
        self._count()
        return entry

    def download(self, *args, **kwargs):
        entry = super().download(*args, **kwargs)
        self._count()
        return entry


# ─── The engine ───────────────────────────────────────────────────────────────

def test_a_cancel_before_the_pass_starts_moves_nothing(project, remote_base):
    write(project, "main.tex", "body")
    provider = LocalFolderProvider(remote_base)

    report = SyncEngine(
        project, provider, CloudState(settings=CloudSettings(enabled=True)),
        should_cancel=lambda: True,
    ).run()

    assert report.cancelled
    assert not report.ok
    assert report.uploaded == []


def test_a_cancelled_pass_keeps_what_it_moved_and_the_next_pass_resumes(project, remote_base):
    for index in range(5):
        write(project, f"file{index}.tex", str(index))
    provider = LocalFolderProvider(remote_base)
    state = CloudState(settings=CloudSettings(enabled=True))
    uploads = []

    def should_cancel():
        return len(uploads) >= 2

    engine = SyncEngine(
        project, provider, state, should_cancel=should_cancel,
        on_progress=lambda event: uploads.append(event.rel_path) if event.action == "upload" else None,
    )
    report = engine.run()

    # The file in flight finishes; the stop lands before the next one.
    assert report.cancelled
    assert report.uploaded == ["file0.tex", "file1.tex"]
    assert set(state.entries) == {"file0.tex", "file1.tex"}

    resumed = SyncEngine(project, provider, state).run()

    assert resumed.ok
    assert resumed.uploaded == ["file2.tex", "file3.tex", "file4.tex"]


# ─── The service ──────────────────────────────────────────────────────────────

def test_cancelling_when_nothing_runs_says_so(project):
    assert service.request_cancel(project) is False


def test_a_sync_can_be_cancelled_through_the_service(tmp_path, remote_base):
    project = str(tmp_path / "thesis")
    for index in range(5):
        write(project, f"file{index}.tex", str(index))
    save_settings(project, CloudSettings(
        enabled=True,
        provider="local_folder",
        remote_folder="thesis",
        provider_config={"base_dir": remote_base},
    ))
    provider = CancellingProvider(remote_base, project, after=2)

    outcome = service.sync_project("thesis", project, provider=provider)

    assert outcome.report.cancelled
    assert len(outcome.report.uploaded) == 2
    assert service.progress_for(project)["active"] is False
    # What moved is in the saved baseline, so it is not sent again.
    assert set(load_state(project).entries) == set(outcome.report.uploaded)


def test_a_new_pass_starts_uncancelled(tmp_path, remote_base):
    project = str(tmp_path / "thesis")
    write(project, "main.tex", "body")
    save_settings(project, CloudSettings(
        enabled=True, provider="local_folder", remote_folder="thesis",
        provider_config={"base_dir": remote_base},
    ))
    service.sync_project(
        "thesis", project, provider=CancellingProvider(remote_base, project, after=1)
    )

    write(project, "second.tex", "more")
    outcome = service.sync_project("thesis", project, provider=LocalFolderProvider(remote_base))

    assert outcome.report.ok
    assert outcome.report.uploaded == ["second.tex"]


# ─── Downloading a project ────────────────────────────────────────────────────

def test_a_cancelled_download_removes_the_folder_it_created(tmp_path, remote_base):
    seed_remote(remote_base, "thesis", 5)
    destination = str(tmp_path / "machine-b" / "thesis")
    provider = CancellingProvider(remote_base, destination, after=2)

    outcome = service.clone_project(
        "local_folder", "thesis", destination,
        provider_config={"base_dir": remote_base}, provider=provider,
    )

    assert outcome.cancelled
    assert outcome.partial_copy_removed
    assert not outcome.error
    assert not os.path.exists(destination)
    # The remote is untouched: a pull never writes to it.
    assert len(os.listdir(os.path.join(remote_base, "thesis"))) == 5


def test_a_cancelled_download_keeps_an_empty_folder_the_user_made(tmp_path, remote_base):
    seed_remote(remote_base, "thesis", 5)
    destination = tmp_path / "picked-by-user"
    destination.mkdir()
    provider = CancellingProvider(remote_base, str(destination), after=2)

    outcome = service.clone_project(
        "local_folder", "thesis", str(destination),
        provider_config={"base_dir": remote_base}, provider=provider,
    )

    assert outcome.cancelled
    assert destination.is_dir()
    assert os.listdir(destination) == []


# ─── The endpoints ────────────────────────────────────────────────────────────

async def test_the_cancel_endpoint_reports_when_nothing_is_running(client, tmp_path):
    response = await client.post("/api/cloud/cancel", json={"projectPath": str(tmp_path)})

    assert response.status == 200
    assert await response.json() == {"cancel_requested": False}


async def test_the_cancel_endpoint_requires_a_path(client):
    response = await client.post("/api/cloud/cancel", json={})

    assert response.status == 400


async def test_a_cancelled_download_is_not_an_error_and_registers_nothing(
    client, tmp_path, remote_base, monkeypatch
):
    seed_remote(remote_base, "thesis", 5)
    parent = tmp_path / "projects"
    parent.mkdir()
    destination = str(parent / "thesis")

    original = LocalFolderProvider.download
    calls = []

    def download(self, *args, **kwargs):
        entry = original(self, *args, **kwargs)
        calls.append(1)
        if len(calls) == 1:
            assert service.request_cancel(destination)
        return entry

    monkeypatch.setattr(LocalFolderProvider, "download", download)

    response = await client.post("/api/cloud/clone", json={
        "provider": "local_folder",
        "config": {"base_dir": remote_base},
        "name": "thesis",
        "parentPath": str(parent),
        "folderName": "thesis",
    })

    payload = await response.json()
    assert response.status == 200, payload
    assert payload["cancelled"] is True
    assert payload["partial_copy_removed"] is True
    assert not os.path.exists(destination)
    assert projects.list_projects() == []
