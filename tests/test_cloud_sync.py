"""Sync engine behaviour, exercised against the local-folder provider.

Running the engine against a real provider implementation (rather than a mock)
means these tests also serve as the contract suite every backend has to satisfy:
point `provider` at another implementation and the same expectations apply.
"""

import os

import pytest

from gilzacode.cloud.base import normalize_rel_path
from gilzacode.cloud.engine import PULL, PUSH, SyncEngine, conflict_copy_name
from gilzacode.cloud.providers.local_folder import LocalFolderProvider
from gilzacode.cloud.scanner import scan_project
from gilzacode.cloud.state import CloudSettings, CloudState, load_state, save_state


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


@pytest.fixture
def provider(remote_base):
    return LocalFolderProvider(remote_base)


def write(root, rel_path, content):
    absolute = os.path.join(root, rel_path.replace("/", os.sep))
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    with open(absolute, "w", encoding="utf-8") as handle:
        handle.write(content)
    return absolute


def read(root, rel_path):
    with open(os.path.join(root, rel_path.replace("/", os.sep)), encoding="utf-8") as handle:
        return handle.read()


def sync(project, provider, state=None, **kwargs):
    state = state if state is not None else CloudState(settings=CloudSettings(enabled=True))
    engine = SyncEngine(project, provider, state, **kwargs)
    report = engine.run()
    return report, state


def remote_root(provider, project):
    return provider.ensure_root(os.path.basename(project))


# ─── First sync and steady state ──────────────────────────────────────────────

def test_first_sync_uploads_every_file(project, provider, remote_base):
    write(project, "main.tex", "\\documentclass{article}")
    write(project, "chapters/intro.tex", "intro")

    report, state = sync(project, provider)

    assert report.ok
    assert sorted(report.uploaded) == ["chapters/intro.tex", "main.tex"]
    root = remote_root(provider, project)
    assert read(root, "main.tex") == "\\documentclass{article}"
    assert read(root, "chapters/intro.tex") == "intro"
    assert set(state.entries) == {"main.tex", "chapters/intro.tex"}


def test_second_sync_is_a_no_op(project, provider):
    write(project, "main.tex", "body")
    _, state = sync(project, provider)

    report, _ = sync(project, provider, state=state)

    assert report.ok
    assert report.changed == 0


def test_local_edit_is_uploaded(project, provider):
    write(project, "main.tex", "v1")
    _, state = sync(project, provider)

    write(project, "main.tex", "v2")
    report, state = sync(project, provider, state=state)

    assert report.uploaded == ["main.tex"]
    assert read(remote_root(provider, project), "main.tex") == "v2"


def test_remote_edit_is_downloaded(project, provider):
    write(project, "main.tex", "v1")
    _, state = sync(project, provider)

    write(remote_root(provider, project), "main.tex", "from-other-machine")
    report, state = sync(project, provider, state=state)

    assert report.downloaded == ["main.tex"]
    assert read(project, "main.tex") == "from-other-machine"


def test_new_remote_file_is_downloaded(project, provider):
    write(project, "main.tex", "v1")
    _, state = sync(project, provider)

    write(remote_root(provider, project), "figures/plot.tex", "plot")
    report, state = sync(project, provider, state=state)

    assert report.downloaded == ["figures/plot.tex"]
    assert read(project, "figures/plot.tex") == "plot"


# ─── Deletions ────────────────────────────────────────────────────────────────

def test_local_delete_removes_the_remote_file(project, provider):
    write(project, "main.tex", "v1")
    write(project, "extra.tex", "x")
    _, state = sync(project, provider)

    os.remove(os.path.join(project, "extra.tex"))
    report, state = sync(project, provider, state=state)

    assert report.deleted_remote == ["extra.tex"]
    assert not os.path.exists(os.path.join(remote_root(provider, project), "extra.tex"))
    assert "extra.tex" not in state.entries


def test_remote_delete_removes_the_local_file(project, provider):
    write(project, "main.tex", "v1")
    write(project, "extra.tex", "x")
    _, state = sync(project, provider)

    os.remove(os.path.join(remote_root(provider, project), "extra.tex"))
    report, state = sync(project, provider, state=state)

    assert report.deleted_local == ["extra.tex"]
    assert not os.path.exists(os.path.join(project, "extra.tex"))


def test_local_edit_beats_a_remote_delete(project, provider):
    write(project, "main.tex", "v1")
    _, state = sync(project, provider)

    os.remove(os.path.join(remote_root(provider, project), "main.tex"))
    write(project, "main.tex", "edited-after-the-delete")
    report, state = sync(project, provider, state=state)

    assert report.restored == ["main.tex"]
    assert read(project, "main.tex") == "edited-after-the-delete"
    assert read(remote_root(provider, project), "main.tex") == "edited-after-the-delete"


def test_remote_edit_beats_a_local_delete(project, provider):
    write(project, "main.tex", "v1")
    _, state = sync(project, provider)

    write(remote_root(provider, project), "main.tex", "edited-elsewhere")
    os.remove(os.path.join(project, "main.tex"))
    report, state = sync(project, provider, state=state)

    assert report.restored == ["main.tex"]
    assert read(project, "main.tex") == "edited-elsewhere"


# ─── Conflicts ────────────────────────────────────────────────────────────────

def test_simultaneous_edits_keep_local_and_preserve_remote(project, provider):
    write(project, "main.tex", "v1")
    _, state = sync(project, provider)

    write(project, "main.tex", "local-work")
    write(remote_root(provider, project), "main.tex", "remote-work")
    report, state = sync(project, provider, state=state)

    assert len(report.conflicts) == 1
    conflict = report.conflicts[0]
    assert conflict.rel_path == "main.tex"
    # The working copy keeps the canonical path so the open editor buffer and
    # the file on disk do not diverge.
    assert read(project, "main.tex") == "local-work"
    # The other machine's version survives beside it.
    assert read(project, conflict.conflict_copy) == "remote-work"
    # And local wins the remote path, so both machines converge on it.
    assert read(remote_root(provider, project), "main.tex") == "local-work"


def test_conflict_copy_keeps_the_original_extension(project):
    name = conflict_copy_name("chapters/main.tex")
    assert name.startswith("chapters/main (cloud conflict ")
    assert name.endswith(".tex")


def test_identical_content_on_both_sides_is_adopted_without_transfer(project, provider):
    # First sync of a folder that was already mirrored by hand: same bytes on
    # both sides, no shared history. Nothing should move, and nothing should be
    # reported as a conflict.
    write(project, "main.tex", "same")
    write(remote_root(provider, project), "main.tex", "same")

    report, state = sync(project, provider)

    assert report.ok
    assert report.changed == 0
    assert report.conflicts == []
    assert "main.tex" in state.entries


def test_different_content_with_no_history_is_a_conflict(project, provider):
    write(project, "main.tex", "mine")
    write(remote_root(provider, project), "main.tex", "theirs")

    report, state = sync(project, provider)

    assert len(report.conflicts) == 1
    assert read(project, "main.tex") == "mine"
    assert read(project, report.conflicts[0].conflict_copy) == "theirs"


# ─── Directions ───────────────────────────────────────────────────────────────

def test_push_direction_never_touches_the_working_copy(project, provider):
    write(project, "main.tex", "v1")
    _, state = sync(project, provider)

    write(remote_root(provider, project), "main.tex", "remote-only")
    report, state = sync(project, provider, state=state, direction=PUSH)

    assert report.downloaded == []
    assert read(project, "main.tex") == "v1"


def test_pull_direction_never_writes_to_the_remote(project, provider):
    write(project, "main.tex", "v1")
    _, state = sync(project, provider)

    # Both sides move, which is the one case that used to publish the working
    # copy regardless of direction — a one-way fetch overwriting the very
    # version it was asked to fetch.
    write(project, "main.tex", "edited here")
    write(remote_root(provider, project), "main.tex", "edited there")
    report, state = sync(project, provider, state=state, direction=PULL)

    assert read(remote_root(provider, project), "main.tex") == "edited there"
    assert report.uploaded == []
    # The divergence is still visible: the working copy keeps the canonical
    # path and the remote version is parked beside it.
    assert [c.rel_path for c in report.conflicts] == ["main.tex"]
    assert read(project, "main.tex") == "edited here"
    assert read(project, report.conflicts[0].conflict_copy) == "edited there"


# ─── Safety ───────────────────────────────────────────────────────────────────

def test_mass_remote_disappearance_is_refused(project, provider):
    for index in range(12):
        write(project, f"file{index}.tex", str(index))
    _, state = sync(project, provider)

    # Simulate the dangerous case: the remote folder is emptied or listed
    # incompletely. Propagating that would wipe the user's only copy.
    root = remote_root(provider, project)
    for name in os.listdir(root):
        os.remove(os.path.join(root, name))

    report, state = sync(project, provider, state=state)

    assert not report.ok
    assert "Refusing to delete" in report.aborted
    assert len(os.listdir(project)) >= 12


def test_bulk_delete_proceeds_when_explicitly_allowed(project, provider):
    for index in range(12):
        write(project, f"file{index}.tex", str(index))
    _, state = sync(project, provider)

    root = remote_root(provider, project)
    for name in os.listdir(root):
        os.remove(os.path.join(root, name))

    report, state = sync(project, provider, state=state, allow_bulk_delete=True)

    assert report.ok
    assert len(report.deleted_local) == 12


def test_remote_entry_cannot_escape_the_project_root(project, provider):
    with pytest.raises(ValueError):
        normalize_rel_path("../../etc/passwd")


def test_dry_run_reports_without_changing_anything(project, provider):
    write(project, "main.tex", "v1")
    state = CloudState(settings=CloudSettings(enabled=True))
    engine = SyncEngine(project, provider, state)

    report = engine.run(dry_run=True)

    assert report.uploaded == ["main.tex"]
    assert not os.path.exists(os.path.join(remote_root(provider, project), "main.tex"))


# ─── Exclusions ───────────────────────────────────────────────────────────────

def test_dotenv_is_excluded_by_default(project, provider):
    write(project, "main.tex", "v1")
    write(project, ".env", "OPENAI_API_KEY=secret")

    report, state = sync(project, provider)

    assert report.uploaded == ["main.tex"]
    assert report.skipped.get(".env") == "dotenv"
    assert not os.path.exists(os.path.join(remote_root(provider, project), ".env"))


def test_dotenv_is_uploaded_when_the_user_opts_in(project, provider):
    write(project, "main.tex", "v1")
    write(project, ".env", "OPENAI_API_KEY=secret")
    state = CloudState(settings=CloudSettings(enabled=True, include_dotenv=True))

    report, state = sync(project, provider, state=state)

    assert ".env" in report.uploaded


def test_sync_state_is_never_uploaded(project, provider):
    write(project, "main.tex", "v1")
    save_state(project, CloudState(settings=CloudSettings(enabled=True)))

    report, state = sync(project, provider)

    assert report.uploaded == ["main.tex"]
    assert all("cloud/state.json" not in path for path in report.uploaded)


def test_latex_compile_diagnostics_are_never_uploaded(project, provider):
    write(project, "main.tex", "v1")
    write(project, ".gilzacode/latex_compile_debug.json", "{}")

    report, state = sync(project, provider)

    assert report.uploaded == ["main.tex"]


def test_build_artifacts_are_included_by_default(project, provider):
    write(project, "main.tex", "v1")
    write(project, "main.aux", "aux")
    write(project, "main.synctex.gz", "synctex")

    report, state = sync(project, provider)

    assert sorted(report.uploaded) == ["main.aux", "main.synctex.gz", "main.tex"]


def test_build_artifacts_can_be_turned_off(project, provider):
    write(project, "main.tex", "v1")
    write(project, "main.aux", "aux")
    state = CloudState(settings=CloudSettings(enabled=True, include_build_artifacts=False))

    report, state = sync(project, provider, state=state)

    assert report.uploaded == ["main.tex"]
    assert report.skipped.get("main.aux") == "build-artifact"


def test_extra_excludes_are_honoured(project, provider):
    write(project, "main.tex", "v1")
    write(project, "drafts/old.tex", "old")
    state = CloudState(settings=CloudSettings(enabled=True, extra_excludes=["drafts/*"]))

    report, state = sync(project, provider, state=state)

    assert report.uploaded == ["main.tex"]


# ─── Scanner fast path ────────────────────────────────────────────────────────

def test_scan_reuses_the_recorded_hash_when_size_and_mtime_match(project):
    write(project, "main.tex", "v1")
    settings = CloudSettings(enabled=True)
    first = scan_project(project, settings)

    second = scan_project(project, settings, baseline={
        path: type("E", (), {"hash": "reused", "size": entry.size, "mtime": entry.mtime})()
        for path, entry in first.entries.items()
    })

    assert second.entries["main.tex"].hash == "reused"


def test_scan_rehashes_when_the_file_changed(project):
    write(project, "main.tex", "v1")
    settings = CloudSettings(enabled=True)
    first = scan_project(project, settings)
    write(project, "main.tex", "a much longer body than before")

    second = scan_project(project, settings, baseline={
        path: type("E", (), {"hash": "stale", "size": entry.size, "mtime": entry.mtime})()
        for path, entry in first.entries.items()
    })

    assert second.entries["main.tex"].hash != "stale"


# ─── State persistence ────────────────────────────────────────────────────────

def test_state_round_trips(project):
    state = CloudState(settings=CloudSettings(enabled=True, provider="local_folder"))
    state.record("main.tex", hash_="abc", size=3, mtime=1.5, remote_rev="r1")
    save_state(project, state)

    loaded = load_state(project)

    assert loaded.settings.enabled is True
    assert loaded.settings.provider == "local_folder"
    assert loaded.entries["main.tex"].hash == "abc"
    assert loaded.entries["main.tex"].remote_rev == "r1"


def test_corrupt_state_degrades_to_an_empty_baseline(project):
    path = os.path.join(project, ".gilzacode", "cloud", "state.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("{not json")

    loaded = load_state(project)

    assert loaded.entries == {}
    assert loaded.settings.enabled is False
