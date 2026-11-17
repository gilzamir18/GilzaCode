"""Agent history (``gilzacode/agent_history.py``): turn edges from Claude Code's hooks, review and undo."""

from __future__ import annotations

import asyncio

from aiohttp import web

from gilzacode import agent_history
from gilzacode.server.app import EXCLUSIVE_WORK_PATHS, error, read_json
from gilzacode.server.routes_cloud import notify_change
from gilzacode.server.routes_ide import HUB_KEY

routes = web.RouteTableDef()

# Undo writes project files: it keeps arrival order with the editor's saves.
# Snapshots only read the project (into the shadow repository) and can take a
# while on a large one, so they do not hold the ordering lock; the module's
# per-project lock orders them among themselves.
EXCLUSIVE_WORK_PATHS.add("/api/agent-history/undo")

_STATUS = {"invalid": 400, "not_found": 404, "running": 409, "undone": 409, "conflict": 409,
           "corrupt": 500, "git_failed": 500, "no_git": 503}


def _refusal(exc: agent_history.AgentHistoryError) -> web.Response:
    return error(_STATUS.get(exc.code, 400), str(exc), code=exc.code, **exc.details)


def _publish(request: web.Request, project_path: str, kind: str, turn: dict | None, **extra) -> None:
    request.app[HUB_KEY].publish({"type": "agent_history", "event": kind, "project_path": project_path,
                                  "turn": turn, **extra})


@routes.post("/api/agent-history/turn-start")
async def turn_start(request: web.Request) -> web.Response:
    data = await read_json(request)
    project = str(data.get("projectPath") or "")
    try:
        turn = await asyncio.to_thread(agent_history.begin_turn, project, str(data.get("prompt") or ""),
                                       str(data.get("sessionId") or ""))
    except agent_history.AgentHistoryError as exc:
        return _refusal(exc)
    _publish(request, project, "started", turn)
    return web.json_response({"success": True, "turn": turn})


@routes.post("/api/agent-history/turn-end")
async def turn_end(request: web.Request) -> web.Response:
    data = await read_json(request)
    project = str(data.get("projectPath") or "")
    try:
        turn = await asyncio.to_thread(agent_history.end_turn, project)
    except agent_history.AgentHistoryError as exc:
        return _refusal(exc)
    _publish(request, project, "ended", turn)
    return web.json_response({"success": True, "turn": turn})


@routes.get("/api/agent-history")
async def list_turns(request: web.Request) -> web.Response:
    try:
        result = await asyncio.to_thread(agent_history.list_turns, request.query.get("projectPath", ""))
    except agent_history.AgentHistoryError as exc:
        return _refusal(exc)
    return web.json_response(result)


@routes.get("/api/agent-history/diff")
async def turn_diff(request: web.Request) -> web.Response:
    query = request.query
    try:
        text = await asyncio.to_thread(agent_history.diff, query.get("projectPath", ""), query.get("turn", ""),
                                       query.get("path", ""))
    except agent_history.AgentHistoryError as exc:
        return _refusal(exc)
    return web.json_response({"diff": text})


@routes.post("/api/agent-history/undo")
async def undo(request: web.Request) -> web.Response:
    data = await read_json(request)
    project = str(data.get("projectPath") or "")
    try:
        result = await asyncio.to_thread(agent_history.undo, project, str(data.get("turn") or ""),
                                         force=bool(data.get("force", False)))
    except agent_history.AgentHistoryError as exc:
        return _refusal(exc)
    notify_change(project)
    _publish(request, project, "undone", result["turn"])
    return web.json_response({"success": True, **result})
