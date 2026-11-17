"""Agent history: what each Claude Code turn changed in the project, and undoing it.

GilzaBots' turn checkpoints, adapted (its ``vcs.py`` shadow repository, copied,
not imported). GilzaCode does not run the agent, so it learns where a turn
begins and ends from Claude Code's hooks, which the panel's session is started
with (``claude_cli.claude_session_argv``): ``UserPromptSubmit`` begins a turn,
``Stop`` (and ``SessionEnd``) ends it. The hook is ``gilzacode-mcp hook ...``
(``mcp_bridge.run_hook``), which calls this module through the local API.

Each edge of a turn is a snapshot of the project in a "shadow" Git repository,
``<project>/.gilzacode/agent-history/repo``, whose work tree is the project and
which never touches the user's own repository. A turn is its start and end
snapshots; what differs between them is what the turn changed, whatever wrote it
(Claude Code's edit tools, a shell command, a compile). A turn that changed
nothing is forgotten. The turns are listed in ``agent-history/turns.json``. The
folder holds a ``.gitignore`` of ``*``, so the user's repository never offers
the history to be committed, without GilzaCode editing the user's own
``.gitignore``.

Undoing a turn puts back only the files it changed, as they were when it began
(a file it created is deleted). A file changed again since the turn ended (by
the user or a later turn) is a conflict: it is named, and overwritten only when
the user confirms. While a turn is running nothing is undone, since the running
turn would record the undo as its own change.

Known limits, stated rather than hidden: a file the user saves while a turn
runs is counted as the turn's; files the project's ``.gitignore`` excludes are
not recorded (nor LaTeX build output, ``SHADOW_EXCLUDES``); and a folder with a
``.git`` of its own is recorded as a single entry, so changes inside it are not
seen (``nested_repositories`` lists them for the interface to say so).
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from gilzacode.files import normalize_rel, resolve
from gilzacode.paths import write_text_atomic
from gilzacode.subprocess_utils import host_environment

HISTORY_DIR = os.path.join(".gilzacode", "agent-history")
SHADOW_DIR = os.path.join(HISTORY_DIR, "repo")
TURNS_FILE = os.path.join(HISTORY_DIR, "turns.json")
#: Kept in the list; older turns are dropped (their snapshots stay in the repository).
MAX_TURNS = 200
PROMPT_EXCERPT_CHARS = 400

#: Never recorded: GilzaCode's own folder, other tools' folders, and LaTeX build output.
SHADOW_EXCLUDES = (
    "/.gilzacode/", "/.gilzabots/", "node_modules/", "__pycache__/", ".venv/", "venv/",
    "*.aux", "*.log", "*.out", "*.toc", "*.synctex.gz", "*.synctex(busy)", "*.fls", "*.fdb_latexmk",
    "*.bbl", "*.blg", "*.nav", "*.snm", "*.vrb", "*.xdv", "*.lof", "*.lot", "gilzacode_partial_*",
)

NESTED_REPO_SKIP_DIRS = frozenset({".git", ".gilzacode", ".gilzabots", "node_modules", "__pycache__", ".venv", "venv"})
NESTED_REPO_MAX_DEPTH = 4
NESTED_REPO_LIMIT = 50

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class AgentHistoryError(ValueError):
    """A request that cannot be served; ``code`` classifies it for the interface."""

    def __init__(self, message: str, code: str = "invalid", **details: Any):
        super().__init__(message)
        self.code = code
        self.details = details


def _lock(project: str) -> threading.Lock:
    key = os.path.normcase(os.path.abspath(project))
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def _project(project_path: str) -> str:
    project = os.path.abspath(str(project_path or "").strip() or ".")
    if not str(project_path or "").strip() or not os.path.isdir(project):
        raise AgentHistoryError("The project folder does not exist.")
    return project


def _git(project: str, *args: str, data: bytes | None = None) -> bytes:
    shadow = os.path.join(project, SHADOW_DIR)
    command = ["git", f"--git-dir={shadow}", f"--work-tree={project}",
               "-c", "core.autocrlf=false", "-c", "core.quotepath=false", "-c", "core.safecrlf=false", *args]
    try:
        result = subprocess.run(command, cwd=project, input=data, capture_output=True, env=host_environment())
    except FileNotFoundError:
        raise AgentHistoryError("Git is not installed, and the agent history needs it.", "no_git") from None
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip() or f"exit status {result.returncode}"
        raise AgentHistoryError(f"git {args[0]} failed: {detail[-600:]}", "git_failed")
    return result.stdout


def _ensure_repository(project: str) -> None:
    shadow = os.path.join(project, SHADOW_DIR)
    if not os.path.isdir(shadow):
        os.makedirs(os.path.dirname(shadow), exist_ok=True)
        with open(os.path.join(project, HISTORY_DIR, ".gitignore"), "w", encoding="utf-8", newline="\n") as handle:
            handle.write("# GilzaCode's agent history: local to this machine, never committed.\n*\n")
        _git(project, "init", "--quiet")
        _git(project, "config", "user.name", "GilzaCode agent history")
        _git(project, "config", "user.email", "agent-history@gilzacode.local")
    exclude = os.path.join(shadow, "info", "exclude")
    os.makedirs(os.path.dirname(exclude), exist_ok=True)
    wanted = "\n".join(SHADOW_EXCLUDES) + "\n"
    try:
        current = open(exclude, encoding="utf-8").read()
    except OSError:
        current = ""
    if current != wanted:
        with open(exclude, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(wanted)


def _head(project: str) -> str | None:
    try:
        return _git(project, "rev-parse", "--verify", "--quiet", "HEAD").decode().strip() or None
    except AgentHistoryError:
        return None


def _snapshot(project: str, message: str) -> str:
    """Record the project as it is now; the commit id (HEAD again when nothing changed)."""
    _ensure_repository(project)
    _git(project, "add", "--all", "--", ".")
    head = _head(project)
    if head:
        unchanged = subprocess.run(
            ["git", f"--git-dir={os.path.join(project, SHADOW_DIR)}", f"--work-tree={project}",
             "diff", "--cached", "--quiet"], cwd=project, capture_output=True, env=host_environment())
        if unchanged.returncode == 0:
            return head
    _git(project, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message)
    return _head(project) or ""


def _changed_files(project: str, start: str, end: str) -> list[dict[str, str]]:
    if start == end:
        return []
    out = _git(project, "diff", "--name-status", "--no-renames", "-z", start, end).decode("utf-8", "replace")
    parts = [p for p in out.split("\0") if p]
    return [{"status": parts[i][:1], "path": parts[i + 1]} for i in range(0, len(parts) - 1, 2)]


def _load(project: str) -> list[dict]:
    path = os.path.join(project, TURNS_FILE)
    try:
        data = json.loads(open(path, encoding="utf-8").read())
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        raise AgentHistoryError(f"The agent history list ({TURNS_FILE}) cannot be read: {exc}", "corrupt") from None
    return data if isinstance(data, list) else []


def _save(project: str, turns: list[dict]) -> None:
    write_text_atomic(Path(project) / TURNS_FILE,
                      json.dumps(turns[-MAX_TURNS:], indent=1, ensure_ascii=False))


def _open_turn(turns: list[dict]) -> dict | None:
    return turns[-1] if turns and not turns[-1].get("end") else None


def _finish(project: str, turns: list[dict], turn: dict) -> dict | None:
    """Close `turn`; it is dropped when it changed nothing. The closed turn, or None."""
    end = _snapshot(project, f"After agent turn {turn['id']}")
    files = _changed_files(project, turn["start"], end)
    if not files:
        turns.remove(turn)
        return None
    turn.update(end=end, ended_at=time.time(), files=files)
    return turn


def begin_turn(project_path: str, prompt: str = "", session_id: str = "") -> dict:
    """A turn starts: record the project. A turn still open (interrupted, so no Stop came) is closed first."""
    project = _project(project_path)
    with _lock(project):
        turns = _load(project)
        open_turn = _open_turn(turns)
        if open_turn:
            _finish(project, turns, open_turn)
        start = _snapshot(project, "Before agent turn")
        turn = {"id": uuid.uuid4().hex[:12], "session_id": str(session_id or ""),
                "prompt": str(prompt or "").strip()[:PROMPT_EXCERPT_CHARS],
                "started_at": time.time(), "start": start, "end": None}
        turns.append(turn)
        _save(project, turns)
        return turn


def end_turn(project_path: str) -> dict | None:
    """The open turn ends; what it changed, or None when there was no open turn or it changed nothing."""
    project = _project(project_path)
    with _lock(project):
        turns = _load(project)
        open_turn = _open_turn(turns)
        if not open_turn:
            return None
        finished = _finish(project, turns, open_turn)
        _save(project, turns)
        return finished


def nested_repositories(project: str) -> list[str]:
    """Folders with a ``.git`` of their own, whose files the shadow repository cannot see."""
    found: list[str] = []
    queue: list[tuple[str, int]] = [(project, 0)]
    while queue and len(found) < NESTED_REPO_LIMIT:
        current, depth = queue.pop(0)
        try:
            entries = sorted(os.scandir(current), key=lambda e: e.name)
        except OSError:
            continue
        for entry in entries:
            if entry.name in NESTED_REPO_SKIP_DIRS:
                continue
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            if os.path.exists(os.path.join(entry.path, ".git")):
                found.append(os.path.relpath(entry.path, project).replace(os.sep, "/"))
            elif depth + 1 < NESTED_REPO_MAX_DEPTH:
                queue.append((entry.path, depth + 1))
    return sorted(found)


def list_turns(project_path: str) -> dict:
    """The turns, newest first, and what the history cannot see."""
    project = _project(project_path)
    turns = _load(project)
    return {"turns": list(reversed(turns)), "running": _open_turn(turns) is not None,
            "nested_repositories": nested_repositories(project)}


def _find(turns: list[dict], turn_id: str) -> dict:
    for turn in turns:
        if turn["id"] == turn_id:
            return turn
    raise AgentHistoryError("That agent turn is not in the history.", "not_found")


def diff(project_path: str, turn_id: str, path: str = "") -> str:
    """The unified diff of a turn, or of one of its files."""
    project = _project(project_path)
    turn = _find(_load(project), turn_id)
    if not turn.get("end"):
        raise AgentHistoryError("That turn is still running.", "running")
    args = ["diff", "--no-renames", "--no-color", turn["start"], turn["end"]]
    if path:
        args += ["--", normalize_rel(path)]
    return _git(project, *args).decode("utf-8", "replace")


def _blob(project: str, commit: str, path: str) -> str | None:
    """The object id of `path` in `commit`, or None when the file is not there."""
    try:
        out = _git(project, "ls-tree", "-z", commit, "--", path).decode("utf-8", "replace")
    except AgentHistoryError:
        return None
    entry = out.split("\0")[0]
    return entry.split()[2] if entry.count(" ") >= 2 else None


def _current_blob(project: str, path: str) -> str | None:
    full = resolve(project, path, allow_root=False)
    if not os.path.isfile(full):
        return None
    # With the filters `git add` applies (a project's .gitattributes), so the id
    # is comparable with the one the snapshot stored.
    return _git(project, "hash-object", "--", path).decode().strip()


def undo(project_path: str, turn_id: str, *, force: bool = False) -> dict:
    """Put the files `turn_id` changed back as they were when it began.

    Raises ``AgentHistoryError`` with code ``conflict`` (and ``conflicts``) when
    one of them changed after the turn, unless `force`.
    """
    project = _project(project_path)
    with _lock(project):
        turns = _load(project)
        if _open_turn(turns):
            raise AgentHistoryError("Claude Code is working on a turn. Undo when it has finished, so that "
                                    "turn does not record the undo as its own change.", "running")
        turn = _find(turns, turn_id)
        if turn.get("undone_at"):
            raise AgentHistoryError("That turn was already undone.", "undone")
        files = [entry["path"] for entry in turn.get("files") or []]
        conflicts = [path for path in files if _current_blob(project, path) != _blob(project, turn["end"], path)]
        if conflicts and not force:
            raise AgentHistoryError("Some of these files changed after the turn.", "conflict", conflicts=conflicts)
        restored, deleted = [], []
        for path in files:
            full = resolve(project, path, allow_root=False)
            blob = _blob(project, turn["start"], path)
            if blob is None:
                if os.path.isfile(full):
                    os.remove(full)
                deleted.append(path)
                continue
            # checkout writes the file the way the work tree had it (filters
            # included); the shadow index it also updates is re-read by the
            # next snapshot anyway.
            _git(project, "checkout", turn["start"], "--", path)
            restored.append(path)
        turn["undone_at"] = time.time()
        _save(project, turns)
        return {"turn": turn, "restored": restored, "deleted": deleted}
