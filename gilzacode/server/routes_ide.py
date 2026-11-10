"""The window's command channel, used by the MCP bridge (``gilzacode/mcp_bridge.py``).

* ``GET /api/ide/events`` — the window's stream: commands to carry out, notices.
* ``POST /api/ide/result`` — the window's answer to a command.
* ``POST /api/ide/command`` — the bridge asks the window to do or report something.
* ``POST /api/ide/compile`` — the bridge compiles a ``.tex`` from disk; the window
  is told so it refreshes the PDF or shows the error, as after its own compile.
"""

from __future__ import annotations

import asyncio
import json
import os

from aiohttp import web

from gilzacode.files import PathOutsideProject, normalize_rel, resolve
from gilzacode.ide_control import IdeCommandError, IdeHub
from gilzacode.server.app import EXCLUSIVE_WORK_PATHS, STREAMING_PATHS, error, read_json

routes = web.RouteTableDef()

HUB_KEY = web.AppKey("ide_hub", IdeHub)
STREAMING_PATHS.add("/api/ide/events")
EXCLUSIVE_WORK_PATHS.add("/api/ide/compile")

#: Keeps the window's stream from looking dead to proxies and to the client.
HEARTBEAT_SECONDS = 20.0


def setup(app: web.Application) -> None:
    app[HUB_KEY] = IdeHub()
    app[COMPILE_SEQ_KEY] = [0]


COMPILE_SEQ_KEY = web.AppKey("ide_compile_seq", list)


@routes.get("/api/ide/events")
async def events(request: web.Request) -> web.StreamResponse:
    hub = request.app[HUB_KEY]
    response = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"})
    await response.prepare(request)
    queue: asyncio.Queue = asyncio.Queue()
    hub.listeners.append(queue)
    try:
        await response.write(b": connected\n\n")
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                await response.write(b": heartbeat\n\n")
                continue
            await response.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        if queue in hub.listeners:
            hub.listeners.remove(queue)
    return response


@routes.post("/api/ide/result")
async def result(request: web.Request) -> web.Response:
    data = await read_json(request)
    delivered = request.app[HUB_KEY].resolve(str(data.get("id") or ""), data)
    return web.json_response({"delivered": delivered})


@routes.post("/api/ide/command")
async def command(request: web.Request) -> web.Response:
    data = await read_json(request)
    action, project_path = str(data.get("action") or ""), str(data.get("project_path") or "")
    if not action or not project_path:
        return error(400, "action and project_path are required")
    args = data.get("args") if isinstance(data.get("args"), dict) else {}
    try:
        answer = await request.app[HUB_KEY].send_command(action, args, project_path=project_path)
    except IdeCommandError as exc:
        return error(409, str(exc))
    return web.json_response(answer)


@routes.post("/api/ide/compile")
async def compile_from_disk(request: web.Request) -> web.Response:
    """Compile a project ``.tex`` as saved on disk, and tell the window about the outcome."""
    from gilzacode.server.routes_latex import CompileRequestError, run_compile
    data = await read_json(request)
    project_path, file_path = str(data.get("projectPath") or ""), str(data.get("filePath") or "")
    if not project_path or not os.path.isdir(project_path) or not file_path:
        return error(400, "projectPath (a folder) and filePath are required")
    try:
        full = resolve(project_path, file_path, allow_root=False)
    except PathOutsideProject:
        return error(403, "Forbidden: Path traversal detected")
    if not full.lower().endswith(".tex") or not os.path.isfile(full):
        return error(400, f"{file_path} is not a .tex file of the project.")
    with open(full, "r", encoding="utf-8", errors="replace", newline="") as handle:
        content = handle.read()
    rel = normalize_rel(os.path.relpath(full, project_path))
    try:
        outcome = await run_compile(request.app, {"projectPath": project_path, "filePath": rel, "content": content,
                                                  "draft": bool(data.get("draft", False))})
    except CompileRequestError as exc:
        return error(400, str(exc))
    seq = request.app[COMPILE_SEQ_KEY]
    seq[0] += 1
    request.app[HUB_KEY].publish({
        "type": "latex_compiled", "seq": seq[0], "success": bool(outcome.get("success")),
        "log": outcome.get("log") or "", "filePath": rel, "compiled_main_file": outcome.get("compiled_main_file", ""),
    })
    pdf_path = outcome.get("pdf_path") or ""
    if pdf_path and os.path.isabs(pdf_path):
        try:
            pdf_path = normalize_rel(os.path.relpath(pdf_path, project_path))
        except ValueError:
            pass
    return web.json_response({
        "success": bool(outcome.get("success")),
        "compiled_main_file": outcome.get("compiled_main_file", ""),
        "pdf_path": pdf_path,
        "log": (outcome.get("log") or "")[-6000:],
    })
