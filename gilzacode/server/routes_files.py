"""Project files: tree, read, raw, write, mkdir, copy, import, delete, rename, open.

Contracts are GilzaBots' (``/api/files``, ``/api/file/*``) so the reused front-end
keeps working unchanged. Every path is confined to its project folder; the
project root itself cannot be deleted, renamed or copied.
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
import shutil

from aiohttp import web

from gilzacode import settings
from gilzacode.files import PathOutsideProject, file_tree, normalize_rel, resolve, unique_target
from gilzacode.server.app import error, read_json
from gilzacode.server.routes_cloud import notify_change

routes = web.RouteTableDef()

TRAVERSAL = "Forbidden: Path traversal detected"


def _truthy(value) -> bool:
    return str(value).lower() in {"1", "true", "yes", "on"}


@routes.get("/api/files")
async def list_files(request: web.Request) -> web.Response:
    project_path = request.query.get("projectPath")
    if not project_path:
        return error(400, "projectPath parameter is required")
    if not os.path.isdir(project_path):
        return error(404, "Directory not found")
    show_hidden = _truthy(request.query.get("showHiddenFiles", "false"))
    tree = await asyncio.to_thread(file_tree, project_path, show_hidden=show_hidden,
                                   hidden_extensions=settings.hidden_file_extensions())
    return web.json_response({"files": tree})


@routes.get("/api/file/read")
async def read_file(request: web.Request) -> web.Response:
    project_path, file_path = request.query.get("projectPath"), request.query.get("filePath")
    if not project_path or not file_path:
        return error(400, "projectPath and filePath are required")
    try:
        full = resolve(project_path, file_path)
    except PathOutsideProject:
        return error(403, TRAVERSAL)
    if not os.path.isfile(full):
        return error(404, "File not found")
    try:
        with open(full, "r", encoding="utf-8", newline="") as handle:
            return web.json_response({"content": handle.read()})
    except (OSError, UnicodeDecodeError) as exc:
        return error(500, str(exc))


@routes.get("/api/file/raw")
async def raw_file(request: web.Request) -> web.StreamResponse:
    """The file's bytes, with Range support (PDFs, images, media).

    ``sourceTex`` names the ``.tex`` file holding an ``\\includegraphics`` path:
    ``..`` is then resolved from that file's folder, as LaTeX does, while the
    result must still lie inside the project.
    """
    project_path, file_path = request.query.get("projectPath"), request.query.get("filePath")
    source_tex = request.query.get("sourceTex")
    if not project_path or not file_path:
        return error(400, "projectPath and filePath are required")
    project_abs = os.path.abspath(project_path)
    anchor = project_abs
    if source_tex:
        candidate = os.path.abspath(os.path.join(project_abs, source_tex))
        anchor = candidate if os.path.isdir(candidate) else os.path.dirname(candidate)
    try:
        full = resolve(project_abs, os.path.join(anchor, file_path))
    except PathOutsideProject:
        return error(403, TRAVERSAL)
    if not os.path.isfile(full):
        return error(404, "File not found")
    content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
    return web.FileResponse(full, headers={"Content-Type": content_type})


@routes.post("/api/file/write")
async def write_file(request: web.Request) -> web.Response:
    data = await read_json(request)
    project_path, file_path = data.get("projectPath"), data.get("filePath")
    if not project_path or not file_path:
        return error(400, "projectPath and filePath are required")
    try:
        full = resolve(project_path, file_path, allow_root=False)
    except PathOutsideProject:
        return error(403, TRAVERSAL)
    if data.get("exclusive") and os.path.lexists(full):
        return error(409, f"Path already exists: {file_path}", code="exists")
    content = data.get("content", "")
    if not isinstance(content, str):
        return error(400, "content must be a string")
    try:
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
    except OSError as exc:
        return error(500, str(exc))
    notify_change(project_path)
    return web.json_response({"success": True})


@routes.post("/api/file/mkdir")
async def make_dir(request: web.Request) -> web.Response:
    data = await read_json(request)
    project_path, dir_path = data.get("projectPath"), data.get("dirPath")
    if not project_path or not dir_path:
        return error(400, "projectPath and dirPath are required")
    try:
        full = resolve(project_path, dir_path, allow_root=False)
    except PathOutsideProject:
        return error(403, TRAVERSAL)
    if data.get("exclusive") and os.path.lexists(full):
        return error(409, f"Path already exists: {dir_path}", code="exists")
    try:
        os.makedirs(full, exist_ok=True)
    except OSError as exc:
        return error(500, str(exc))
    notify_change(project_path)
    return web.json_response({"success": True})


@routes.post("/api/file/copy")
async def copy_path(request: web.Request) -> web.Response:
    data = await read_json(request)
    project_path, source, target = data.get("projectPath"), data.get("sourcePath"), data.get("targetPath")
    if not project_path or not source or not target:
        return error(400, "projectPath, sourcePath and targetPath are required")
    try:
        full_source = resolve(project_path, source, allow_root=False)
        full_target = resolve(project_path, target, allow_root=False)
    except PathOutsideProject:
        return error(403, TRAVERSAL)
    if not os.path.exists(full_source):
        return error(404, "Source file not found")
    full_target = unique_target(full_target)

    def work():
        os.makedirs(os.path.dirname(full_target), exist_ok=True)
        if os.path.isdir(full_source):
            shutil.copytree(full_source, full_target)
        else:
            shutil.copy2(full_source, full_target)

    try:
        await asyncio.to_thread(work)
    except OSError as exc:
        return error(500, str(exc))
    notify_change(project_path)
    return web.json_response({"success": True, "targetPath": normalize_rel(os.path.relpath(full_target, project_path))})


@routes.post("/api/file/import")
async def import_file(request: web.Request) -> web.Response:
    """Stream one uploaded file (multipart ``file``) into ``targetDir`` of the project."""
    if not request.content_type.startswith("multipart/form-data"):
        return error(400, "multipart/form-data is required")
    reader = await request.multipart()
    fields: dict[str, str] = {}
    written: str | None = None
    project_abs = ""
    try:
        while (part := await reader.next()) is not None:
            if part.name != "file":
                fields[part.name] = await part.text()
                continue
            project_path = fields.get("projectPath")
            if not project_path:
                return error(400, "projectPath must precede file in the form")
            project_abs = os.path.abspath(project_path)
            if not os.path.isdir(project_abs):
                return error(404, "Project directory not found")
            name = os.path.basename((part.filename or "").replace("\\", "/")).strip()
            if not name:
                return error(400, "Imported file must have a name")
            try:
                target_dir = resolve(project_abs, fields.get("targetDir", "") or "")
                target = unique_target(resolve(project_abs, os.path.join(target_dir, name), allow_root=False))
            except PathOutsideProject:
                return error(403, TRAVERSAL)
            os.makedirs(target_dir, exist_ok=True)
            with open(target, "wb") as handle:
                while chunk := await part.read_chunk():
                    handle.write(chunk)
            written = target
    except OSError as exc:
        return error(500, str(exc))
    if written is None:
        return error(400, "projectPath and file are required")
    notify_change(project_abs)
    return web.json_response({"success": True, "filePath": normalize_rel(os.path.relpath(written, project_abs))})


@routes.post("/api/file/delete")
async def delete_path(request: web.Request) -> web.Response:
    data = await read_json(request)
    project_path, file_path = data.get("projectPath"), data.get("filePath")
    if not project_path or not file_path:
        return error(400, "projectPath and filePath are required")
    try:
        full = resolve(project_path, file_path, allow_root=False)
    except PathOutsideProject:
        return error(403, TRAVERSAL)
    if not os.path.lexists(full):
        return error(404, "File not found")
    try:
        if os.path.isdir(full) and not os.path.islink(full):
            await asyncio.to_thread(shutil.rmtree, full)
        else:
            os.remove(full)
    except OSError as exc:
        return error(500, str(exc))
    notify_change(project_path)
    return web.json_response({"success": True})


@routes.post("/api/file/rename")
async def rename_path(request: web.Request) -> web.Response:
    data = await read_json(request)
    project_path, old, new = data.get("projectPath"), data.get("oldPath"), data.get("newPath")
    if not project_path or not old or not new:
        return error(400, "projectPath, oldPath and newPath are required")
    try:
        full_old = resolve(project_path, old, allow_root=False)
        full_new = resolve(project_path, new, allow_root=False)
    except PathOutsideProject:
        return error(403, TRAVERSAL)
    if not os.path.lexists(full_old):
        return error(404, "Source file not found")
    try:
        os.makedirs(os.path.dirname(full_new), exist_ok=True)
        os.rename(full_old, full_new)
    except OSError as exc:
        return error(500, str(exc))
    notify_change(project_path)
    return web.json_response({"success": True})


@routes.post("/api/file/open-explorer")
async def open_in_explorer(request: web.Request) -> web.Response:
    """Open the project folder, or one of its files, with the Windows shell."""
    data = await read_json(request)
    project_path, file_path = data.get("projectPath"), data.get("filePath")
    if not project_path or not os.path.isdir(project_path):
        return error(400, "Valid projectPath is required")
    target = project_path
    if file_path:
        try:
            target = resolve(project_path, file_path)
        except PathOutsideProject:
            return error(403, TRAVERSAL)
        if not os.path.exists(target):
            return error(404, "File not found")
    try:
        await asyncio.to_thread(os.startfile, os.path.abspath(target))
    except OSError as exc:
        return error(500, str(exc))
    return web.json_response({"success": True})
