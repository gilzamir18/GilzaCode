"""End-to-end sync between two machines sharing one remote folder.

`sync_project` is the whole feature from the server's point of view, so these
tests drive it the way the endpoints do.
"""

import os

import pytest

from gilzacode.cloud import service
from gilzacode.cloud.providers.local_folder import LocalFolderProvider
from gilzacode.cloud.registry import get_cloud_provider, list_providers, register_provider
from gilzacode.cloud.state import CloudSettings, load_state, save_settings


@pytest.fixture
def shared_remote(tmp_path):
    path = tmp_path / "remote"
    path.mkdir()
    return str(path)


def make_machine(tmp_path, name, remote_base, project_name="alpha"):
    """A project directory on its own computer, mirrored to the shared remote."""
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


def write(root, rel_path, content):
    absolute = os.path.join(root, rel_path.replace("/", os.sep))
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    with open(absolute, "w", encoding="utf-8") as handle:
        handle.write(content)


def read(root, rel_path):
    with open(os.path.join(root, rel_path.replace("/", os.sep)), encoding="utf-8") as handle:
        return handle.read()


def sync(machine, monkeypatch, **kwargs):
    return service.sync_project(machine["name"], machine["path"], **kwargs)


# ─── Files ────────────────────────────────────────────────────────────────────

def test_a_file_written_on_one_machine_reaches_the_other(tmp_path, shared_remote, monkeypatch):
    desktop = make_machine(tmp_path, "desktop", shared_remote)
    laptop = make_machine(tmp_path, "laptop", shared_remote)

    write(desktop["path"], "main.tex", "\\section{Intro}")
    first = sync(desktop, monkeypatch)
    second = sync(laptop, monkeypatch)

    assert first.report.ok and second.report.ok
    assert read(laptop["path"], "main.tex") == "\\section{Intro}"


def test_settings_without_a_provider_report_a_clear_error(tmp_path, shared_remote, monkeypatch):
    machine = make_machine(tmp_path, "solo", shared_remote)
    save_settings(machine["path"], CloudSettings(enabled=True, provider=""))

    outcome = sync(machine, monkeypatch)

    assert outcome.report is None
    assert "No cloud provider" in outcome.error


def test_an_unknown_provider_fails_instead_of_falling_back(tmp_path, shared_remote, monkeypatch):
    # Silently mirroring to a different backend than the one recorded would put
    # the user's files somewhere they never chose.
    machine = make_machine(tmp_path, "solo", shared_remote)
    save_settings(machine["path"], CloudSettings(enabled=True, provider="dropbox_someday"))

    outcome = sync(machine, monkeypatch)

    assert "Unknown cloud provider" in outcome.error


def test_the_baseline_is_persisted_after_a_pass(tmp_path, shared_remote, monkeypatch):
    machine = make_machine(tmp_path, "desktop", shared_remote)
    write(machine["path"], "main.tex", "body")

    sync(machine, monkeypatch)

    state = load_state(machine["path"])
    assert "main.tex" in state.entries
    assert state.last_sync_at


# ─── Status and settings plumbing ─────────────────────────────────────────────

def test_status_reports_providers_and_connection(tmp_path, shared_remote):
    machine = make_machine(tmp_path, "desktop", shared_remote)

    status = service.status_for(machine["path"], machine["name"])

    assert status["settings"]["provider"] == "local_folder"
    assert status["connected"] is True  # the destination folder exists and is writable
    assert any(p["id"] == "google_drive" for p in status["providers"])


def test_status_surfaces_a_missing_destination(tmp_path, shared_remote):
    machine = make_machine(tmp_path, "desktop", shared_remote)
    service.update_settings(machine["path"], {"provider_config": {"base_dir": str(tmp_path / "gone")}})

    status = service.status_for(machine["path"], machine["name"])

    assert status["connected"] is False
    assert "not found" in status["auth_error"].lower()


def test_update_settings_only_touches_known_keys(tmp_path, shared_remote):
    machine = make_machine(tmp_path, "desktop", shared_remote)

    settings = service.update_settings(machine["path"], {
        "include_build_artifacts": False,
        "not_a_real_setting": "ignored",
    })

    assert settings.include_build_artifacts is False
    assert settings.provider == "local_folder"  # untouched keys survive
    assert not hasattr(settings, "not_a_real_setting")


def test_switching_provider_drops_the_stale_baseline(tmp_path, shared_remote):
    # Remote revisions and the root handle belong to the old backend; comparing
    # against them after a switch could never match.
    machine = make_machine(tmp_path, "desktop", shared_remote)
    state = load_state(machine["path"])
    state.record("main.tex", hash_="h", size=1, mtime=1.0, remote_rev="r")
    state.root = "old-root"
    from gilzacode.cloud.state import save_state
    save_state(machine["path"], state)

    service.update_settings(machine["path"], {"provider": "google_drive"})

    after = load_state(machine["path"])
    assert after.entries == {}
    assert after.root == ""


# ─── Registry ─────────────────────────────────────────────────────────────────

def test_a_new_backend_needs_only_a_registry_entry(tmp_path, shared_remote, monkeypatch):
    # The point of the facade: a second provider plugs in without the engine or
    # the service knowing anything about it.
    calls = []

    class RecordingProvider(LocalFolderProvider):
        id = "recording"
        display_name = "Recording"

        def upload(self, root, rel_path, local_path, expected_rev=None):
            calls.append(rel_path)
            return super().upload(root, rel_path, local_path, expected_rev)

    register_provider(
        "recording", "Recording",
        lambda config: RecordingProvider(config.get("base_dir", "")),
        requires_authorization=False,
    )

    machine = make_machine(tmp_path, "desktop", shared_remote)
    save_settings(machine["path"], CloudSettings(
        enabled=True, provider="recording", remote_folder="alpha",
        provider_config={"base_dir": shared_remote},
    ))
    write(machine["path"], "main.tex", "body")

    outcome = sync(machine, monkeypatch)

    assert outcome.report.ok
    assert "main.tex" in calls
    assert any(p.id == "recording" for p in list_providers())


def test_google_drive_is_listed_as_available_without_extra_dependencies():
    # The backend is stdlib-only on purpose; a packaged build must not need an
    # optional install for it to appear.
    info = next(p for p in list_providers() if p.id == "google_drive")

    assert info.available
    assert info.requires_authorization


def test_google_drive_reports_it_needs_a_client_when_none_is_set(monkeypatch):
    from gilzacode.cloud.providers import google_drive

    monkeypatch.setattr(google_drive, "load_client_config", lambda: {"client_id": "", "client_secret": ""})
    monkeypatch.setattr(google_drive, "_load_token", lambda: google_drive._Token())

    status = get_cloud_provider("google_drive").auth_status()

    assert status.connected is False
    assert "OAuth client" in status.error
