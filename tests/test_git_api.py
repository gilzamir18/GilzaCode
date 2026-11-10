"""The Git view against real repositories (cases kept from GilzaBots' test_git_root_context.py)."""

import shutil
import subprocess

import pytest

from gilzacode import git_repo
from gilzacode.git_repo import GitContextError

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def repo(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "a.txt").write_text("original", encoding="utf-8")
    _git(project, "init", "-q")
    _git(project, "config", "user.email", "test@example.com")
    _git(project, "config", "user.name", "Test")
    _git(project, "add", ".")
    _git(project, "commit", "-qm", "initial")
    return project


def P(path):
    return str(path)


async def test_a_project_without_git_is_reported_not_failed(client, tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    data = await (await client.get("/api/git/status", params={"projectPath": P(plain)})).json()
    assert data["git_available"] is False and data["files"] == []
    head = await (await client.get("/api/git/file-at-head", params={"projectPath": P(plain), "filePath": "x"})).json()
    assert head["git_available"] is False


async def test_status_stage_commit_log_and_file_at_head(client, repo):
    (repo / "a.txt").write_text("changed", encoding="utf-8")
    (repo / "new.txt").write_text("new", encoding="utf-8")
    status = await (await client.get("/api/git/status", params={"projectPath": P(repo)})).json()
    assert sorted((f["path"], f["status"], f["staged"]) for f in status["files"]) == [
        ("a.txt", "M", False), ("new.txt", "??", False)]

    assert (await client.post("/api/git/stage", json={"projectPath": P(repo), "filePath": "__all__"})).status == 200
    status = await (await client.get("/api/git/status", params={"projectPath": P(repo)})).json()
    assert all(f["staged"] for f in status["files"])

    assert (await client.post("/api/git/commit", json={"projectPath": P(repo), "message": "second"})).status == 200
    nothing = await client.post("/api/git/commit", json={"projectPath": P(repo), "message": "third"})
    assert nothing.status == 400 and "Nothing to commit" in (await nothing.json())["error"]

    log = await (await client.get("/api/git/log", params={"projectPath": P(repo), "limit": "1"})).json()
    assert [c["message"] for c in log["commits"]] == ["second"] and log["has_more"] is True
    head = await (await client.get("/api/git/file-at-head", params={"projectPath": P(repo), "filePath": "a.txt"})).json()
    assert head == {"content": "changed", "source": "git"}


async def test_diffs(client, repo):
    (repo / "a.txt").write_text("changed", encoding="utf-8")
    (repo / "u.txt").write_text("untracked", encoding="utf-8")
    working = await (await client.get("/api/git/diff", params={"projectPath": P(repo), "filePath": "a.txt"})).json()
    assert "+changed" in working["diff"]
    untracked = await (await client.get("/api/git/diff", params={"projectPath": P(repo), "filePath": "u.txt"})).json()
    assert "+untracked" in untracked["diff"]
    root = _git(repo, "rev-parse", "HEAD").stdout.strip()
    first = await (await client.get("/api/git/diff", params={"projectPath": P(repo), "commit": root})).json()
    assert "+original" in first["diff"]  # the root commit is shown, it has no parent
    bad = await client.get("/api/git/diff", params={"projectPath": P(repo), "commit": "--output=x"})
    assert bad.status == 400


async def test_discard_restores_staged_modified_and_removes_new_files(client, repo):
    (repo / "a.txt").write_text("changed", encoding="utf-8")
    _git(repo, "add", "a.txt")
    (repo / "new.txt").write_text("new", encoding="utf-8")
    _git(repo, "add", "new.txt")
    (repo / "scratch.txt").write_text("scratch", encoding="utf-8")
    for name in ("a.txt", "new.txt", "scratch.txt"):
        assert (await client.post("/api/git/discard", json={"projectPath": P(repo), "filePath": name})).status == 200
    assert (repo / "a.txt").read_text(encoding="utf-8") == "original"
    assert not (repo / "new.txt").exists() and not (repo / "scratch.txt").exists()
    assert _git(repo, "status", "--porcelain").stdout == ""


def test_discard_keeps_the_file_when_git_cannot_answer(repo):
    """A corrupt index makes ``ls-files`` exit 128; that is not "untracked"."""
    (repo / "a.txt").write_text("changed", encoding="utf-8")
    ctx = git_repo.resolve(str(repo))
    (repo / ".git" / "index").write_bytes(b"garbage")
    with pytest.raises(RuntimeError):
        git_repo.discard(ctx, "a.txt")
    assert (repo / "a.txt").read_text(encoding="utf-8") == "changed"


async def test_shadow_history_is_refused_not_served_from_the_user_repository(client, repo):
    response = await client.get("/api/git/log", params={"projectPath": P(repo), "shadow": "true"})
    assert response.status == 400
    assert "/rewind" in (await response.json())["error"]


def test_a_git_root_inside_the_project_maps_paths(tmp_path, repo):
    inner = repo / "inner"
    inner.mkdir()
    (inner / "b.txt").write_text("b", encoding="utf-8")
    _git(inner, "init", "-q")
    ctx = git_repo.resolve(str(repo), str(inner))
    assert git_repo.to_project_path("b.txt", ctx) == "inner/b.txt"
    assert git_repo.to_repo_path("inner/b.txt", ctx) == "b.txt"
    with pytest.raises(GitContextError):
        git_repo.to_repo_path("a.txt", ctx)  # inside the project, outside the chosen repository
    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(GitContextError):
        git_repo.resolve(str(repo), str(outside))


def test_partial_compile_artifacts_are_excluded(repo):
    ctx = git_repo.resolve(str(repo))
    git_repo.ensure_excludes(ctx)
    git_repo.ensure_excludes(ctx)  # idempotent
    (repo / "gilzacode_partial_main.tex").write_text("generated", encoding="utf-8")
    assert _git(repo, "status", "--porcelain").stdout == ""
    assert (repo / ".git" / "info" / "exclude").read_text(encoding="utf-8").count("gilzacode_partial_*") == 1


def test_quoted_git_paths_are_unescaped():
    ctx = git_repo.GitContext("/p", "/p", "")
    assert git_repo.to_project_path('"file (1).pdf"', ctx) == "file (1).pdf"
    assert git_repo.to_project_path('"Diret\\303\\263rio/A\\303\\247\\303\\272car.pdf"', ctx) == "Diretório/Açúcar.pdf"
