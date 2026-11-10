"""The registry of projects. In GilzaCode a project is a folder and a name.

GilzaBots kept projects in SQLite with models, skills and chats; none of that
exists here (Claude Code owns the conversation), so the registry is a JSON
list in ``<gilzacode home>/projects.json``. Removing a project from the list
never touches its folder unless the caller explicitly asks for that.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from gilzacode.files import is_within
from gilzacode.paths import gilzacode_home, writable_dir_problem, write_text_atomic

_lock = threading.RLock()


class ProjectError(ValueError):
    """A request about projects that cannot be honoured; the message is for the user."""


@dataclass
class Project:
    name: str            # stable key
    project_name: str    # display name
    project_path: str    # absolute folder
    created_at: float
    main_file: str = ""  # the LaTeX root, relative to the folder; "" lets the compiler decide
    git_root_path: str = ""  # a repository other than the folder's own, for the Git view
    compile_on_save_partial: bool = True  # GilzaBots' default: a save compiles the edited part
    compile_on_save_full: bool = False

    def to_json(self) -> dict:
        data = asdict(self)
        data["exists"] = os.path.isdir(self.project_path)
        return data


def registry_path() -> Path:
    return gilzacode_home() / "projects.json"


def _load() -> list[Project]:
    path = registry_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        # Do not silently start from an empty list: saving it would erase the registry.
        raise ProjectError(f"The project registry '{path}' cannot be read: {exc}") from exc
    known = set(Project.__dataclass_fields__)
    return [Project(**{k: v for k, v in entry.items() if k in known}) for entry in raw.get("projects", [])]


def _save(projects: list[Project]) -> None:
    write_text_atomic(registry_path(), json.dumps(
        {"projects": [asdict(p) for p in projects]}, indent=2, ensure_ascii=False))


def _same_folder(a: str, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _key_for(display_name: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9_-]+", "_", display_name.strip().lower()).strip("_") or "project"
    key, counter = base, 1
    while key in taken:
        key = f"{base}_{counter}"
        counter += 1
    return key


def list_projects() -> list[Project]:
    with _lock:
        return _load()


def get(name: str) -> Project | None:
    return next((p for p in list_projects() if p.name == name), None)


def add(project_name: str, project_path: str, *, must_exist: bool) -> Project:
    """Register a folder as a project.

    `must_exist` distinguishes opening an existing folder (import) from creating
    a new one, which is created here when missing.
    """
    project_name = (project_name or "").strip()
    if not project_path or not str(project_path).strip():
        raise ProjectError("A project folder is required.")
    folder = os.path.abspath(os.path.expanduser(str(project_path).strip()))
    if not project_name:
        project_name = os.path.basename(folder.rstrip("\\/")) or folder
    if os.path.exists(folder) and not os.path.isdir(folder):
        raise ProjectError(f"The path '{folder}' exists but is not a folder.")
    if must_exist and not os.path.isdir(folder):
        raise ProjectError(f"The folder '{folder}' does not exist.")
    problem = writable_dir_problem(folder)
    if problem:
        raise ProjectError(f"Cannot use '{folder}' as a project folder: {problem}.")
    with _lock:
        projects = _load()
        existing = next((p for p in projects if _same_folder(p.project_path, folder)), None)
        if existing:
            raise ProjectError(f"This folder is already the project '{existing.project_name}'.")
        project = Project(
            name=_key_for(project_name, {p.name for p in projects}),
            project_name=project_name,
            project_path=folder,
            created_at=time.time(),
        )
        projects.append(project)
        _save(projects)
        return project


#: Fields a client may change, with the type each must have.
UPDATABLE = {"project_name": str, "project_path": str, "main_file": str, "git_root_path": str,
             "compile_on_save_partial": bool, "compile_on_save_full": bool}


def update(name: str, changes: dict) -> Project:
    """Change a project's settings. Unknown or mistyped fields are refused, not ignored."""
    unknown = set(changes) - set(UPDATABLE)
    if unknown:
        raise ProjectError(f"These project fields cannot be changed: {', '.join(sorted(unknown))}.")
    for key, kind in UPDATABLE.items():
        if key in changes and not isinstance(changes[key], kind):
            raise ProjectError(f"'{key}' must be a {kind.__name__}.")
    if "project_name" in changes and not changes["project_name"].strip():
        raise ProjectError("A project name is required.")
    with _lock:
        projects = _load()
        project = next((p for p in projects if p.name == name), None)
        if project is None:
            raise ProjectError(f"There is no project '{name}'.")
        if "project_path" in changes:
            # Repairing a project whose folder moved: the new folder must exist and
            # be writable, and must not already be another project.
            folder = os.path.abspath(os.path.expanduser(changes["project_path"].strip()))
            if not os.path.isdir(folder):
                raise ProjectError(f"The folder '{folder}' does not exist.")
            problem = writable_dir_problem(folder)
            if problem:
                raise ProjectError(f"Cannot use '{folder}' as a project folder: {problem}.")
            other = next((p for p in projects if p.name != name and _same_folder(p.project_path, folder)), None)
            if other:
                raise ProjectError(f"This folder is already the project '{other.project_name}'.")
            changes = {**changes, "project_path": folder}
        root = os.path.abspath(changes.get("project_path", project.project_path))
        if changes.get("main_file"):
            main = os.path.abspath(os.path.join(root, changes["main_file"]))
            if not is_within(main, root):
                raise ProjectError("The main file must be inside the project folder.")
            changes = {**changes, "main_file": os.path.relpath(main, root).replace("\\", "/")}
        if changes.get("git_root_path"):
            git_root = os.path.abspath(changes["git_root_path"])
            if not is_within(git_root, root):
                raise ProjectError("The Git root must be inside the project folder.")
            changes = {**changes, "git_root_path": git_root}
        if changes.get("compile_on_save_full"):
            changes = {**changes, "compile_on_save_partial": False}  # the two are exclusive
        for key, value in changes.items():
            setattr(project, key, value.strip() if key == "project_name" else value)
        _save(projects)
        return project


def remove(name: str, *, delete_folder: bool = False) -> Project:
    """Unregister a project; delete its folder only when `delete_folder` is true."""
    with _lock:
        projects = _load()
        project = next((p for p in projects if p.name == name), None)
        if project is None:
            raise ProjectError(f"There is no project '{name}'.")
        if delete_folder and os.path.isdir(project.project_path):
            folder = os.path.abspath(project.project_path)
            if os.path.dirname(folder) == folder:
                raise ProjectError(f"Refusing to delete the drive root '{folder}'.")
            shutil.rmtree(folder)
        _save([p for p in projects if p.name != name])
        return project
