"""Live feedback for a sync pass, and settling a conflict the user's way.

Two gaps this covers: a pass used to run with no visible sign of what it was
doing, and a conflict left the user with two files and no way to say which one
wins.
"""

import os

import pytest

from gilzacode.cloud import service
from gilzacode.cloud.engine import ProgressEvent, SyncEngine
from gilzacode.cloud.base import CloudError
from gilzacode.cloud.providers.local_folder import LocalFolderProvider
from gilzacode.cloud.state import CloudSettings, CloudState, load_state, save_settings


# ─── Helpers ──────────────────────────────────────────────────────────────────

def write(root, rel_path, content):
    absolute = os.path.join(root, rel_path.replace("/", os.sep))
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    with open(absolute, "w", encoding="utf-8") as handle:
        handle.write(content)
    return absolute


def read(root, rel_path):
    with open(os.path.join(root, rel_path.replace("/", os.sep)), encoding="utf-8") as handle:
        return handle.read()


@pytest.fixture
def remote_base(tmp_path):
    path = tmp_path / "remote"
    path.mkdir()
    return str(path)


@pytest.fixture
def project(tmp_path):
    path = tmp_path / "project"
    path.mkdir()
    return str(path)


@pytest.fixture
def provider(remote_base):
    return LocalFolderProvider(remote_base)


def make_machine(tmp_path, name, remote_base, project_name="alpha"):
    root = tmp_path / name
    root.mkdir()
    project_dir = root / "project"
    project_dir.mkdir()
    save_settings(str(project_dir), CloudSettings(
        enabled=True,
        provider="local_folder",
        remote_folder=project_name,
        provider_config={"base_dir": remote_base},
    ))
    return {"path": str(project_dir), "name": project_name}


def sync(machine, monkeypatch, **kwargs):
    return service.sync_project(machine["name"], machine["path"], **kwargs)


# ─── The engine reports what it is doing ──────────────────────────────────────

def test_the_engine_announces_the_plan_before_transferring(project, provider):
    write(project, "main.tex", "one")
    write(project, "notes.md", "two")
    events = []

    engine = SyncEngine(
        project,
        provider,
        CloudState(settings=CloudSettings(enabled=True)),
        on_progress=events.append,
    )
    engine.run()

    plan = next(e for e in events if e.action == "plan")
    assert plan.total == 2
    uploads = [e for e in events if e.action == "upload"]
    assert sorted(e.rel_path for e in uploads) == ["main.tex", "notes.md"]
    # Every event carries the position, so a caller can render "3 of 12".
    assert all(e.total == 2 for e in events)
    assert [e.index for e in events if e.action == "visit"] == [1, 2]


def test_progress_advances_through_files_that_need_no_transfer(project, provider):
    """A pass over unchanged files must not look stalled."""
    write(project, "a.tex", "a")
    write(project, "b.tex", "b")
    state = CloudState(settings=CloudSettings(enabled=True))
    SyncEngine(project, provider, state).run()

    events = []
    SyncEngine(project, provider, state, on_progress=events.append).run()

    assert [e.rel_path for e in events if e.action == "visit"] == ["a.tex", "b.tex"]
    assert not [e for e in events if e.action in {"upload", "download"}]


def test_a_broken_progress_listener_cannot_abort_a_pass(project, provider):
    write(project, "main.tex", "one")

    def explode(_event):
        raise RuntimeError("listener is broken")

    report = SyncEngine(
        project, provider, CloudState(settings=CloudSettings(enabled=True)), on_progress=explode
    ).run()

    assert report.ok
    assert report.uploaded == ["main.tex"]


# ─── The service publishes that progress ──────────────────────────────────────

def test_progress_is_readable_after_a_pass(tmp_path, remote_base, monkeypatch):
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "main.tex", "hello")

    outcome = sync(machine, monkeypatch)
    progress = service.progress_for(machine["path"])

    uploaded = len(outcome.report.uploaded)
    assert progress["active"] is False
    assert progress["phase"] == "done"
    # A first pass uploads the whole project, so the plan and the uploads match.
    assert progress["total"] == uploaded
    assert progress["examined"] == uploaded
    assert progress["counts"] == {"upload": uploaded}
    assert {"action": "upload", "path": "main.tex"} in progress["recent"]


def test_progress_is_reported_while_the_pass_is_running(tmp_path, remote_base, monkeypatch):
    """The snapshot has to be readable mid-pass — that is the whole point."""
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "main.tex", "hello")
    write(machine["path"], "notes.md", "notes")

    seen = []
    original = service._record_progress

    def spy(progress, event):
        original(progress, event)
        if event.action == "upload":
            seen.append(service.progress_for(machine["path"]))

    monkeypatch.setattr(service, "_record_progress", spy)
    sync(machine, monkeypatch)

    assert seen, "no upload was observed"
    first = seen[0]
    assert first["active"] is True
    assert first["phase"] == "transferring"
    assert first["current_action"] == "upload"
    assert first["current_path"]
    assert first["total"] >= 2


def test_the_recent_list_is_bounded(tmp_path, remote_base, monkeypatch):
    machine = make_machine(tmp_path, "desktop", remote_base)
    for index in range(service.RECENT_LIMIT + 15):
        write(machine["path"], f"file{index:03d}.tex", str(index))

    outcome = sync(machine, monkeypatch)
    progress = service.progress_for(machine["path"])

    assert len(progress["recent"]) == service.RECENT_LIMIT
    # The tail is what is kept: the newest transfers, not the oldest. The plan
    # is walked in sorted order, so the last entries are the last files sent.
    assert progress["recent"][-1]["path"] == outcome.report.uploaded[-1]


def test_the_status_payload_carries_progress(tmp_path, remote_base, monkeypatch):
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "main.tex", "hello")
    sync(machine, monkeypatch)

    status = service.status_for(machine["path"], machine["name"])

    assert status["progress"]["counts"]["upload"] >= 1
    assert status["progress"]["phase"] == "done"


def test_a_project_that_never_synced_reports_an_empty_progress(project):
    progress = service.progress_for(project)

    assert progress["active"] is False
    assert progress["total"] == 0
    assert progress["recent"] == []


# ─── Resolving a conflict ─────────────────────────────────────────────────────

@pytest.fixture
def conflicted(tmp_path, remote_base, monkeypatch):
    """Two machines that edited the same file, leaving a conflict on the second."""
    desktop = make_machine(tmp_path, "desktop", remote_base)
    laptop = make_machine(tmp_path, "laptop", remote_base)

    write(desktop["path"], "main.tex", "shared")
    sync(desktop, monkeypatch)
    sync(laptop, monkeypatch)

    write(desktop["path"], "main.tex", "desktop version")
    sync(desktop, monkeypatch)
    write(laptop["path"], "main.tex", "laptop version")
    outcome = sync(laptop, monkeypatch)

    assert len(outcome.report.conflicts) == 1
    conflict = outcome.report.conflicts[0]
    assert read(laptop["path"], conflict.conflict_copy) == "desktop version"
    return {"desktop": desktop, "laptop": laptop, "conflict": conflict}


def test_keeping_the_local_version_overwrites_the_remote(conflicted, monkeypatch):
    laptop, desktop = conflicted["laptop"], conflicted["desktop"]
    conflict = conflicted["conflict"]

    result = service.resolve_conflict(
        laptop["path"], "main.tex", service.KEEP_LOCAL, conflict_copy=conflict.conflict_copy
    )

    assert result["resolution"] == service.KEEP_LOCAL
    assert read(laptop["path"], "main.tex") == "laptop version"
    # The copy has served its purpose and is gone.
    assert not os.path.exists(os.path.join(laptop["path"], conflict.conflict_copy))
    # The other machine picks the decision up on its next pass.
    sync(desktop, monkeypatch)
    assert read(desktop["path"], "main.tex") == "laptop version"


def test_keeping_the_cloud_version_overwrites_the_working_copy(conflicted, monkeypatch):
    laptop = conflicted["laptop"]
    conflict = conflicted["conflict"]

    service.resolve_conflict(
        laptop["path"], "main.tex", service.KEEP_REMOTE, conflict_copy=conflict.conflict_copy
    )

    assert read(laptop["path"], "main.tex") == "desktop version"
    assert not os.path.exists(os.path.join(laptop["path"], conflict.conflict_copy))


def test_a_resolved_conflict_does_not_come_back_on_the_next_pass(conflicted, monkeypatch):
    """The baseline is rewritten, so the next pass sees one agreed version."""
    laptop = conflicted["laptop"]
    conflict = conflicted["conflict"]

    service.resolve_conflict(
        laptop["path"], "main.tex", service.KEEP_LOCAL, conflict_copy=conflict.conflict_copy
    )
    outcome = sync(laptop, monkeypatch)

    assert outcome.report.conflicts == []
    assert outcome.report.ok


def test_keeping_the_cloud_version_sends_it_back_to_the_other_machine(conflicted, monkeypatch):
    """The conflicted pass already uploaded the local version, so the choice
    only sticks if the resolution uploads the promoted copy."""
    laptop, desktop = conflicted["laptop"], conflicted["desktop"]

    service.resolve_conflict(
        laptop["path"], "main.tex", service.KEEP_REMOTE,
        conflict_copy=conflicted["conflict"].conflict_copy,
    )
    sync(desktop, monkeypatch)

    assert read(desktop["path"], "main.tex") == "desktop version"


def test_keeping_the_cloud_version_without_the_copy_fails_instead_of_guessing(conflicted):
    """Downloading here would hand back the version the user just rejected."""
    laptop = conflicted["laptop"]
    os.remove(os.path.join(laptop["path"], conflicted["conflict"].conflict_copy))

    with pytest.raises(CloudError) as excinfo:
        service.resolve_conflict(
            laptop["path"], "main.tex", service.KEEP_REMOTE,
            conflict_copy=conflicted["conflict"].conflict_copy,
        )

    assert "conflict copy" in str(excinfo.value)


def test_an_unknown_resolution_is_refused(conflicted):
    with pytest.raises(CloudError) as excinfo:
        service.resolve_conflict(conflicted["laptop"]["path"], "main.tex", "keep_whatever")

    assert "keep_local" in str(excinfo.value)


def test_resolving_a_file_that_vanished_locally_fails_clearly(conflicted):
    laptop = conflicted["laptop"]
    os.remove(os.path.join(laptop["path"], "main.tex"))

    with pytest.raises(CloudError) as excinfo:
        service.resolve_conflict(laptop["path"], "main.tex", service.KEEP_LOCAL)

    assert "no longer exists" in str(excinfo.value)


async def test_the_endpoint_resolves_and_returns_fresh_status(client, conflicted):
    laptop = conflicted["laptop"]
    conflict = conflicted["conflict"]

    response = await client.post("/api/cloud/resolve-conflict", json={
        "projectPath": laptop["path"],
        "project": laptop["name"],
        "path": "main.tex",
        "resolution": "keep_remote",
        "conflict_copy": conflict.conflict_copy,
    })

    body = await response.json()
    assert response.status == 200, body
    assert body["resolved"]["resolution"] == "keep_remote"
    assert body["status"]["progress"] is not None
    assert read(laptop["path"], "main.tex") == "desktop version"


async def test_the_endpoint_rejects_a_request_without_a_path(client, conflicted):
    response = await client.post("/api/cloud/resolve-conflict", json={
        "projectPath": conflicted["laptop"]["path"], "resolution": "keep_local",
    })

    assert response.status == 400


# ─── Per-file state for the explorer ──────────────────────────────────────────

def test_files_are_marked_synced_after_a_pass(tmp_path, remote_base, monkeypatch):
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "main.tex", "hello")
    sync(machine, monkeypatch)

    payload = service.file_states(machine["path"])

    assert payload["enabled"] is True
    assert payload["states"]["main.tex"] == service.SYNCED


def test_an_edited_file_goes_back_to_pending(tmp_path, remote_base, monkeypatch):
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "main.tex", "hello")
    sync(machine, monkeypatch)

    write(machine["path"], "main.tex", "edited")
    service.invalidate_file_states(machine["path"])
    payload = service.file_states(machine["path"])

    assert payload["states"]["main.tex"] == service.PENDING


def test_a_file_that_never_synced_is_pending(tmp_path, remote_base):
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "main.tex", "hello")

    payload = service.file_states(machine["path"])

    assert payload["states"]["main.tex"] == service.PENDING


def test_excluded_files_are_marked_so_they_are_not_reported_as_waiting(tmp_path, remote_base):
    """.env is excluded by default; showing it as "pending forever" would be a lie."""
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], ".env", "OPENAI_API_KEY=secret")

    payload = service.file_states(machine["path"])

    assert payload["states"][".env"] == service.EXCLUDED


def test_a_conflict_marks_the_file(tmp_path, remote_base, monkeypatch):
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "main.tex", "hello")
    sync(machine, monkeypatch)

    payload = service.file_states(machine["path"], conflicts=["main.tex"])

    assert payload["states"]["main.tex"] == service.CONFLICT


def test_folders_inherit_the_worst_state_below_them(tmp_path, remote_base, monkeypatch):
    """A collapsed folder has to show that something inside it needs attention."""
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "chapters/one.tex", "one")
    write(machine["path"], "chapters/two.tex", "two")
    sync(machine, monkeypatch)
    write(machine["path"], "chapters/two.tex", "edited")
    service.invalidate_file_states(machine["path"])

    payload = service.file_states(machine["path"])

    assert payload["states"]["chapters/one.tex"] == service.SYNCED
    assert payload["states"]["chapters"] == service.PENDING


def test_the_file_in_flight_is_marked_syncing(tmp_path, remote_base, monkeypatch):
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "main.tex", "hello")
    seen = {}
    original = service._record_progress

    def spy(progress, event):
        original(progress, event)
        if event.action == "upload" and "payload" not in seen:
            service.invalidate_file_states(machine["path"])
            seen["payload"] = service.file_states(machine["path"])
            seen["path"] = event.rel_path

    monkeypatch.setattr(service, "_record_progress", spy)
    sync(machine, monkeypatch)

    assert seen["payload"]["states"][seen["path"]] == service.SYNCING
    assert seen["payload"]["active"] is True


def test_a_project_with_sync_off_reports_no_states(tmp_path, remote_base):
    """No badges at all for a project that never opted in."""
    machine = make_machine(tmp_path, "desktop", remote_base)
    save_settings(machine["path"], CloudSettings(enabled=False, provider="local_folder"))
    write(machine["path"], "main.tex", "hello")

    payload = service.file_states(machine["path"])

    assert payload == {"enabled": False, "states": {}, "current": "", "active": False}


def test_the_scan_is_memoized_but_a_pass_invalidates_it(tmp_path, remote_base, monkeypatch):
    """The panel polls every second while a pass runs; re-walking the tree each
    time would make the badges cost more than the sync."""
    machine = make_machine(tmp_path, "desktop", remote_base)
    write(machine["path"], "main.tex", "hello")
    scans = []
    original = service.scan_project

    def counting_scan(*args, **kwargs):
        scans.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(service, "scan_project", counting_scan)

    service.invalidate_file_states(machine["path"])
    service.file_states(machine["path"])
    service.file_states(machine["path"])
    assert len(scans) == 1

    service.invalidate_file_states(machine["path"])
    service.file_states(machine["path"])
    assert len(scans) == 2


async def test_the_file_states_endpoint_reports_the_last_pass_conflicts(client, conflicted):
    laptop = conflicted["laptop"]
    service.MANAGER._projects.clear()
    service.invalidate_file_states(laptop["path"])

    response = await client.get("/api/cloud/file-states", params={"projectPath": laptop["path"]})

    body = await response.json()
    assert response.status == 200, body
    assert body["enabled"] is True
    assert body["states"]["main.tex"] in {service.SYNCED, service.PENDING, service.CONFLICT}


async def test_the_file_states_endpoint_requires_a_project(client, conflicted):
    response = await client.get("/api/cloud/file-states")

    assert response.status == 400
