"""The user's Git repository behind the Git view: context resolution and path mapping.

Ported from GilzaBots' ``ide_server.py`` helpers. GilzaBots also had a "shadow"
repository of agent checkpoints; GilzaCode has none (Claude Code keeps its own
checkpoints), and a request for it is refused rather than served from the
user's repository.
"""

from __future__ import annotations

import codecs
import os
import shutil
import subprocess
from dataclasses import dataclass

from gilzacode.files import is_within, normalize_rel
from gilzacode.subprocess_utils import utf8_text_kwargs

#: Temporary files of partial LaTeX compiles; never shown as changes.
HIDDEN_ARTIFACT_PREFIXES = ("gilzacode_partial_",)
GIT_EXCLUDE_PATTERNS = ("gilzacode_partial_*",)


class GitContextError(ValueError):
    """The project has no usable repository for the request; the message is for the user."""


@dataclass(frozen=True)
class GitContext:
    project_path: str
    repo_root: str
    repo_prefix: str  # the repository's folder relative to the project, "" when it is the project

    def run(self, *args: str, text: bool = True, check: bool = False) -> subprocess.CompletedProcess:
        kwargs = utf8_text_kwargs() if text else {}
        return subprocess.run(["git", *args], cwd=self.repo_root, capture_output=True, check=check, **kwargs)


def resolve(project_path: str, git_root_path: str | None = None, shadow: bool = False) -> GitContext:
    if shadow:
        raise GitContextError("GilzaCode has no agent checkpoint history; use Claude Code's /rewind.")
    project_abs = os.path.abspath(project_path)
    if not os.path.isdir(project_abs):
        raise GitContextError("Invalid project path")
    repo_root = os.path.abspath(git_root_path) if git_root_path else project_abs
    if not os.path.isdir(repo_root):
        raise GitContextError("Invalid Git root path")
    if not is_within(repo_root, project_abs):
        raise GitContextError("Git root must be inside the project path")
    if not os.path.exists(os.path.join(repo_root, ".git")):
        raise GitContextError("Selected Git root does not contain a .git repository")
    prefix = os.path.relpath(repo_root, project_abs)
    return GitContext(project_abs, repo_root, "" if prefix == "." else normalize_rel(prefix))


def is_hidden_artifact(path: str) -> bool:
    return os.path.basename(path).lower().startswith(HIDDEN_ARTIFACT_PREFIXES)


def ensure_excludes(ctx: GitContext) -> None:
    """Keep partial-compile temporaries out of ``git status`` via ``.git/info/exclude``."""
    meta = os.path.join(ctx.repo_root, ".git")
    if not os.path.isdir(meta):
        return  # a worktree or submodule: .git is a file, and its exclude lives elsewhere
    exclude = os.path.join(meta, "info", "exclude")
    existing = set()
    if os.path.exists(exclude):
        with open(exclude, "r", encoding="utf-8", errors="ignore") as handle:
            existing = {line.strip() for line in handle if line.strip() and not line.lstrip().startswith("#")}
    missing = [p for p in GIT_EXCLUDE_PATTERNS if p not in existing]
    if not missing:
        return
    os.makedirs(os.path.dirname(exclude), exist_ok=True)
    needs_newline = False
    if os.path.exists(exclude) and os.path.getsize(exclude) > 0:
        with open(exclude, "rb") as handle:
            handle.seek(-1, os.SEEK_END)
            needs_newline = handle.read(1) not in {b"\n", b"\r"}
    with open(exclude, "a", encoding="utf-8") as handle:
        if needs_newline:
            handle.write("\n")
        handle.write("# GilzaCode generated artifacts\n")
        for pattern in missing:
            handle.write(pattern + "\n")


def unquote(path: str) -> str:
    """Undo Git's C-style quoting of paths with special characters."""
    if path.startswith('"') and path.endswith('"'):
        try:
            return codecs.escape_decode(bytes(path[1:-1], "utf-8"))[0].decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return path[1:-1]
    return path


def to_project_path(repo_path: str, ctx: GitContext) -> str:
    clean = normalize_rel(unquote(repo_path))
    prefix = ctx.repo_prefix
    return normalize_rel(f"{prefix}/{clean}" if prefix and clean else prefix or clean)


def to_repo_path(file_path: str, ctx: GitContext) -> str:
    file_abs = os.path.abspath(file_path if os.path.isabs(file_path) else os.path.join(ctx.project_path, file_path))
    if not is_within(file_abs, ctx.project_path):
        raise GitContextError("File path is outside the project path")
    if not is_within(file_abs, ctx.repo_root):
        raise GitContextError("File path is outside the selected Git root")
    return normalize_rel(os.path.relpath(file_abs, ctx.repo_root))


def status(ctx: GitContext) -> list[dict]:
    ensure_excludes(ctx)
    result = ctx.run("status", "--porcelain")
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout or "git status failed")
    files = []
    for line in result.stdout.splitlines():
        if len(line) <= 3:
            continue
        index, worktree, path = line[0], line[1], line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ")[1].strip()
        path = to_project_path(path, ctx)
        if is_hidden_artifact(path):
            continue
        if index == "?" and worktree == "?":
            files.append({"path": path, "status": "??", "staged": False})
        elif index not in (" ", "?"):
            files.append({"path": path, "status": index, "staged": True})
        else:
            files.append({"path": path, "status": worktree, "staged": False})
    return files


def verify_commit(ctx: GitContext, commit: str) -> str:
    """The full hash of `commit`, or ``""`` when it names no commit."""
    if not commit or commit.startswith("-"):
        return ""
    result = ctx.run("rev-parse", "--verify", f"{commit}^{{commit}}")
    return result.stdout.strip() if result.returncode == 0 else ""


def discard(ctx: GitContext, repo_file_path: str) -> None:
    """Discard tracked/staged changes, or remove an untracked path."""
    listed = ctx.run("ls-files", "--error-unmatch", "--", repo_file_path)
    if listed.returncode == 0:
        restored = ctx.run("restore", "--staged", "--worktree", "--", repo_file_path)
        if restored.returncode != 0:
            raise RuntimeError(restored.stderr or restored.stdout or "Git restore failed")
        return
    # Exit status 1 is the only answer meaning "not tracked". 128 means Git could
    # not answer (dubious ownership, a corrupt index); taking that for "untracked"
    # would delete a tracked file the user asked to restore.
    if listed.returncode != 1:
        raise RuntimeError(listed.stderr or listed.stdout or f"git ls-files failed with exit status {listed.returncode}")
    full = os.path.abspath(os.path.join(ctx.repo_root, repo_file_path))
    if not is_within(full, ctx.repo_root):
        raise GitContextError("File path is outside the selected Git root")
    if os.path.isdir(full):
        shutil.rmtree(full)
    elif os.path.exists(full):
        os.remove(full)

