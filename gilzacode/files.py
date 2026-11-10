"""Path confinement and the project tree."""

from __future__ import annotations

import os

#: Never listed in the project tree.
SKIPPED_DIRS = frozenset({"node_modules", ".git", ".venv", ".env", "__pycache__", ".pytest_cache"})


class PathOutsideProject(ValueError):
    """A requested path resolves outside its project folder."""


def is_within(child: str, parent: str) -> bool:
    """Whether `child` is `parent` or lies inside it (case-insensitive on Windows)."""
    child = os.path.normcase(os.path.abspath(child))
    parent = os.path.normcase(os.path.abspath(parent))
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:  # different drives
        return False


def is_project_root(path: str, root: str) -> bool:
    return os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(root))


def resolve(project_path: str, rel_path: str, *, allow_root: bool = True) -> str:
    """The absolute path of `rel_path` inside the project, or `PathOutsideProject`."""
    full = os.path.abspath(os.path.join(project_path, rel_path))
    if not is_within(full, project_path) or (not allow_root and is_project_root(full, project_path)):
        raise PathOutsideProject(rel_path)
    return full


def normalize_rel(path: str) -> str:
    return path.replace("\\", "/")


def file_tree(dir_path: str, root_path: str | None = None, *, show_hidden: bool = False,
              hidden_extensions: list[str] | tuple[str, ...] = ()) -> list[dict]:
    """The folder's entries, directories first, each ``{name, path, isDirectory[, children]}``.

    ``os.scandir`` gives each entry's type from the listing itself, avoiding a
    stat per entry (the slow part on NTFS, and what antivirus scanners hook).
    """
    root_path = root_path or dir_path
    try:
        with os.scandir(dir_path) as it:
            entries = list(it)
    except OSError:
        return []
    result = []
    for entry in entries:
        name = entry.name
        if name in SKIPPED_DIRS:
            continue
        rel = os.path.relpath(entry.path, root_path)
        try:
            is_dir = entry.is_dir()
        except OSError:
            is_dir = False
        if is_dir:
            result.append({
                "name": name, "path": rel, "isDirectory": True,
                "children": file_tree(entry.path, root_path, show_hidden=show_hidden,
                                      hidden_extensions=hidden_extensions),
            })
        else:
            if not show_hidden and name.lower().endswith(tuple(hidden_extensions)):
                continue
            result.append({"name": name, "path": rel, "isDirectory": False})
    result.sort(key=lambda item: (not item["isDirectory"], item["name"].lower()))
    return result


def unique_target(path: str) -> str:
    """`path`, or ``name_copy.ext``, ``name_copy2.ext``... when it already exists."""
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    counter = 1
    while True:
        candidate = f"{base}_copy{counter if counter > 1 else ''}{ext}"
        if not os.path.exists(candidate):
            return candidate
        counter += 1
