"""Projects (folders the user works in) and the folder picker."""

from __future__ import annotations

import os
import string
import sys

from aiohttp import web

from gilzacode import projects, settings
from gilzacode.server.app import error, read_json

routes = web.RouteTableDef()


@routes.get("/api/projects/list")
async def list_projects(_request: web.Request) -> web.Response:
    try:
        items = [p.to_json() for p in projects.list_projects()]
    except projects.ProjectError as exc:
        return error(500, str(exc))
    last = settings.load().get("last_active_project", "")
    return web.json_response({"projects": items, "last_active_project": last if isinstance(last, str) else ""})


async def _add(request: web.Request, *, must_exist: bool) -> web.Response:
    data = await read_json(request)
    try:
        project = projects.add(data.get("project_name", ""), data.get("project_path", ""), must_exist=must_exist)
    except projects.ProjectError as exc:
        return error(400, str(exc))
    return web.json_response(project.to_json())


@routes.post("/api/projects/create")
async def create_project(request: web.Request) -> web.Response:
    """Register a folder, creating it when missing."""
    return await _add(request, must_exist=False)


@routes.post("/api/projects/import")
async def import_project(request: web.Request) -> web.Response:
    """Register an existing folder."""
    return await _add(request, must_exist=True)


@routes.post("/api/projects/update")
async def update_project(request: web.Request) -> web.Response:
    """``{"name": key, "changes": {field: value}}``; see `projects.UPDATABLE`."""
    data = await read_json(request)
    changes = data.get("changes")
    if not isinstance(changes, dict):
        return error(400, "changes must be an object")
    try:
        project = projects.update(data.get("name", ""), changes)
    except projects.ProjectError as exc:
        return error(400, str(exc))
    return web.json_response(project.to_json())


@routes.post("/api/projects/delete")
async def delete_project(request: web.Request) -> web.Response:
    """Unregister a project; its folder is deleted only with ``delete_dir: true``."""
    data = await read_json(request)
    try:
        project = projects.remove(data.get("name", ""), delete_folder=bool(data.get("delete_dir", False)))
    except projects.ProjectError as exc:
        return error(400, str(exc))
    except OSError as exc:
        return error(500, f"The folder could not be deleted: {exc}")
    current = settings.load()
    if current.get("last_active_project") == project.name:
        settings.save({"last_active_project": ""})
    return web.json_response({"success": True})


@routes.post("/api/settings/last-project")
async def set_last_project(request: web.Request) -> web.Response:
    data = await read_json(request)
    name = data.get("project_name")
    if not isinstance(name, str) or not name.strip():
        return error(400, "project_name must be a non-empty string")
    settings.save({"last_active_project": name})
    return web.json_response({"success": True, "last_active_project": name})


@routes.post("/api/fs/dirs")
async def list_dirs(request: web.Request) -> web.Response:
    """Subfolders of ``path`` for the folder picker.

    Navigation entries (``..``, or the drives at a root) do not depend on reading
    the folder, so they are returned even when listing it fails: an unreadable
    folder such as the *My Documents* junction must not trap the picker.
    """
    data = await read_json(request)
    req_path = data.get("path")
    if not req_path or req_path == "~":
        req_path = os.path.expanduser("~")
    req_path = os.path.abspath(os.path.expanduser(req_path))
    if not os.path.isdir(req_path):
        req_path = os.path.expanduser("~")

    nav = []
    parent = os.path.dirname(req_path)
    if parent != req_path:
        nav.append({"name": "..", "path": parent})
    elif sys.platform == "win32":
        for letter in string.ascii_uppercase:
            drive = f"{letter}:\\"
            if drive != req_path and os.path.exists(drive):
                nav.append({"name": f".. ({letter}:)", "path": drive})
    try:
        entries = list(nav)
        for name in sorted(os.listdir(req_path), key=str.lower):
            full = os.path.join(req_path, name)
            if not name.startswith(".") and os.path.isdir(full):
                entries.append({"name": name, "path": full})
    except PermissionError:
        return web.json_response({"error": "Permission denied", "current": req_path, "dirs": nav}, status=403)
    except OSError as exc:
        return web.json_response({"error": str(exc), "current": req_path, "dirs": nav}, status=500)
    return web.json_response({"current": req_path, "dirs": entries})
