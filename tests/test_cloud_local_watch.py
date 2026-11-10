"""Edits nobody announces still get synced.

Claude Code writes into the project directly on disk, where no endpoint sees
it, so the manager watches each synced project with a stat-only walk. These
tests cover the fingerprint, the watch loop, and the announcements the file
endpoints still make for the editor's own saves.
"""

import asyncio
import os

import pytest

from gilzacode.cloud import service
from gilzacode.cloud.state import CloudSettings, save_settings


def write(root, rel_path, content):
    absolute = os.path.join(root, rel_path.replace("/", os.sep))
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    with open(absolute, "w", encoding="utf-8") as handle:
        handle.write(content)
    return absolute


@pytest.fixture
def folder(tmp_path):
    path = tmp_path / "thesis"
    path.mkdir()
    write(str(path), "main.tex", "v1")
    return str(path)


@pytest.fixture
def synced(folder, tmp_path):
    remote = tmp_path / "remote"
    remote.mkdir()
    save_settings(folder, CloudSettings(
        enabled=True, provider="local_folder", remote_folder="thesis",
        provider_config={"base_dir": str(remote)},
    ))
    return folder


# ─── The fingerprint ──────────────────────────────────────────────────────────

def test_an_edit_changes_the_fingerprint(folder):
    settings = CloudSettings(enabled=True)
    before = service.local_signature(folder, settings)

    write(folder, "main.tex", "a longer second version")

    assert service.local_signature(folder, settings) != before


def test_a_new_file_changes_the_fingerprint(folder):
    settings = CloudSettings(enabled=True)
    before = service.local_signature(folder, settings)

    write(folder, "chapters/one.tex", "new")

    assert service.local_signature(folder, settings) != before


def test_files_outside_the_sync_set_do_not_change_it(folder):
    """The sync's own bookkeeping and excluded files must not start a pass."""
    settings = CloudSettings(enabled=True)
    before = service.local_signature(folder, settings)

    write(folder, ".gilzacode/cloud/state.json", "{}")
    write(folder, ".gilzacode/latex_compile_debug.json", "{}")
    write(folder, ".env", "SECRET=1")
    write(folder, "node_modules/pkg/index.js", "x")

    assert service.local_signature(folder, settings) == before


def test_an_unchanged_project_keeps_its_fingerprint(folder):
    settings = CloudSettings(enabled=True)

    assert service.local_signature(folder, settings) == service.local_signature(folder, settings)


# ─── The watch loop ───────────────────────────────────────────────────────────

async def test_the_watch_announces_an_edit_made_on_disk(synced):
    registration = service._Registration(project_name="thesis", project_path=synced)
    task = asyncio.create_task(service._watch_project(registration, 0.02))
    try:
        await asyncio.sleep(0.1)
        assert not registration.dirty.is_set()  # the first look is only a baseline

        write(synced, "main.tex", "edited by Claude Code")

        await asyncio.wait_for(registration.dirty.wait(), timeout=2)
    finally:
        task.cancel()


async def test_the_watch_announces_an_edit_seen_while_a_pass_runs(synced):
    """The edit may have landed after the pass scanned; the run loop holds it."""
    registration = service._Registration(project_name="thesis", project_path=synced)
    registration.running = True
    task = asyncio.create_task(service._watch_project(registration, 0.02))
    try:
        await asyncio.sleep(0.1)
        write(synced, "main.tex", "edited during the pass")

        await asyncio.wait_for(registration.dirty.wait(), timeout=2)
    finally:
        task.cancel()


async def test_activating_starts_both_tasks_and_deactivating_stops_them(synced):
    manager = service.CloudSyncManager()

    assert manager.activate("thesis", synced) is True
    registration = manager._projects[service._key(synced)]
    assert not registration.task.done() and not registration.watch_task.done()

    # A second activation keeps the running tasks rather than adding more.
    task, watch = registration.task, registration.watch_task
    assert manager.activate("thesis", synced) is True
    assert (registration.task, registration.watch_task) == (task, watch)

    manager.deactivate(synced)
    await asyncio.sleep(0)
    assert task.cancelled() and watch.cancelled()


async def test_a_watch_that_ended_is_restarted_beside_a_live_sync_task(synced):
    manager = service.CloudSyncManager()
    manager.activate("thesis", synced)
    registration = manager._projects[service._key(synced)]
    registration.watch_task.cancel()
    await asyncio.sleep(0)

    assert manager.activate("thesis", synced) is True
    assert not registration.watch_task.done()
    manager.shutdown()


async def test_a_project_without_auto_sync_gets_no_watch(folder):
    save_settings(folder, CloudSettings(enabled=True, provider="local_folder", auto_sync=False))
    manager = service.CloudSyncManager()

    assert manager.activate("thesis", folder) is False
    assert service._key(folder) not in manager._projects


# ─── The endpoints announce the editor's own writes ───────────────────────────

async def test_saving_through_the_editor_announces_the_change(client, synced, monkeypatch):
    announced = []
    monkeypatch.setattr(service.MANAGER, "notify_local_change", announced.append)

    response = await client.post("/api/file/write", json={
        "projectPath": synced, "filePath": "main.tex", "content": "saved",
    })

    assert response.status == 200
    assert announced == [synced]


async def test_opening_a_synced_project_starts_its_background_sync(client, synced):
    response = await client.get("/api/cloud/status", params={"projectPath": synced, "project": "thesis"})

    payload = await response.json()
    assert response.status == 200, payload
    assert payload["settings"]["provider"] == "local_folder"
    registration = service.MANAGER._projects.get(service._key(synced))
    assert registration is not None and not registration.watch_task.done()
    service.MANAGER.deactivate(synced)
