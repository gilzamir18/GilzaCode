"""The integrated terminal: one PTY session per bottom-panel tab, streamed over SSE.

The Claude Code panel uses the same transport with the id ``claude``: its PTY
runs the `claude` CLI instead of a shell (``routes_claude.py``). Unlike a shell,
an exited Claude session is not restarted by reconnecting: the stream answers
410 and the panel offers to start it again. When Claude Code exits by itself,
its stream ends with an ``ended`` event, so the panel does not have to wait for
that reconnect to find out.

Contracts are GilzaBots'. Tab ids are ``main`` and ``main-<n>``. A tab keeps its
id across a project switch, so a session found under it that belongs to
another project is closed and a fresh shell is started in the requested one.

The stream sends base64 chunks with the stream offset as the SSE id. A client
that reconnects sends ``Last-Event-ID`` and receives only what it missed.
"""

from __future__ import annotations

import asyncio
import base64
import os

from aiohttp import web

from gilzacode.files import is_within
from gilzacode.server.app import STREAMING_PATHS, error, read_json
from gilzacode.terminal_manager import TerminalSession, screen_text

routes = web.RouteTableDef()

STREAMING_PATHS.add("/api/terminal/stream")

SESSIONS_KEY = web.AppKey("terminal_sessions", dict)


def setup(app: web.Application) -> None:
    app[SESSIONS_KEY] = {}

    async def close_all(app_: web.Application) -> None:
        for session in list(app_[SESSIONS_KEY].values()):
            session.close()
        app_[SESSIONS_KEY].clear()

    app.on_cleanup.append(close_all)


CLAUDE_ID = "claude"


def _is_tab(term_id: str) -> bool:
    return term_id == "main" or term_id.startswith("main-") or term_id == CLAUDE_ID


class SessionEnded(Exception):
    """The Claude session exited; it is restarted only on request."""


def _new_session(term_id: str, project_path: str) -> TerminalSession:
    if term_id != CLAUDE_ID:
        return TerminalSession(project_path)
    from gilzacode.claude_cli import claude_session_argv, claude_session_env
    return TerminalSession(project_path, argv=claude_session_argv(), env=claude_session_env(project_path))


def _same_path(a: str, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def close_sessions_in(app: web.Application, folder: str) -> None:
    """Close every session (shell tabs and Claude Code) started in `folder` or below it.

    Windows cannot delete a folder that is a process' working directory, so a
    project's folder can only be deleted once the sessions running in it are gone.
    """
    for session in list(app[SESSIONS_KEY].values()):
        if is_within(session.project_path, folder):
            session.close()


def discard_claude_session(app: web.Application) -> bool:
    """Close the Claude Code session and forget it; return whether one was running.

    Used when what the session was started with has changed (the model
    provider): the next stream or ``/api/claude/start`` then starts a new one,
    with the current environment, instead of reconnecting to this one.
    """
    session = app[SESSIONS_KEY].pop(CLAUDE_ID, None)
    if session is None:
        return False
    was_running = session.is_running
    session.close()
    return was_running


def _session_for(request: web.Request, term_id: str, project_path: str | None,
                 restart: bool = False) -> TerminalSession | None:
    """The tab's running session in `project_path`, started when needed; None without a project.

    An exited Claude session in the same project raises `SessionEnded` unless
    `restart` is true.
    """
    sessions = request.app[SESSIONS_KEY]
    current = sessions.get(term_id)
    same_project = current is not None and (not project_path or _same_path(current.project_path, project_path))
    if current is not None and current.is_running and same_project:
        return current
    if term_id == CLAUDE_ID and current is not None and current.exited and same_project and not restart:
        raise SessionEnded()
    if not project_path or not os.path.isdir(project_path):
        return None
    if current is not None:
        current.close()
    session = _new_session(term_id, project_path)
    session.start_reading(asyncio.get_running_loop())
    sessions[term_id] = session
    return session


@routes.get("/api/terminal/stream")
async def stream(request: web.Request) -> web.StreamResponse:
    term_id = request.query.get("term_id", "main")
    if not _is_tab(term_id):
        return error(400, "Unknown terminal id")
    try:
        last_event_id = int(request.headers.get("Last-Event-ID", ""))
    except ValueError:
        last_event_id = None
    try:
        session = _session_for(request, term_id, request.query.get("projectPath"))
    except SessionEnded:
        return error(410, "Claude Code has ended.", kind="ended")
    except Exception as exc:  # the PTY could not be created, or `claude` is missing
        return error(503 if term_id == CLAUDE_ID else 500, f"Failed to start: {exc}")
    if session is None:
        return error(400, "Project path required")

    response = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"})
    await response.prepare(request)
    # Subscribe, then snapshot the scrollback with no await in between: everything
    # up to `offset` comes from the backlog and the rest from the queue.
    queue: asyncio.Queue = asyncio.Queue()
    session.queues.append(queue)
    backlog, offset = session.backlog_since(last_event_id)

    async def send(chunk: bytes, at: int) -> None:
        await response.write(f"id: {at}\ndata: {base64.b64encode(chunk).decode('ascii')}\n\n".encode("ascii"))

    try:
        if backlog:
            await send(backlog, offset)
        while (chunk := await queue.get()) is not None:
            offset += len(chunk)
            await send(chunk, offset)
        if term_id == CLAUDE_ID and session.ended_by_itself:
            # Said outright, so the panel shows that Claude Code ended at once
            # instead of learning it from a reconnect answered 410 seconds later.
            await response.write(b"event: ended\ndata: \n\n")
    except (ConnectionResetError, asyncio.CancelledError):
        pass  # the client went away
    finally:
        if queue in session.queues:
            session.queues.remove(queue)
    return response


@routes.post("/api/terminal/input")
async def terminal_input(request: web.Request) -> web.Response:
    """``{"action": "input", "text": ...}`` or ``{"action": "resize", "cols": n, "rows": n}``."""
    data = await read_json(request)
    term_id = data.get("term_id", "main")
    if not _is_tab(term_id):
        return error(400, "Unknown terminal id")
    try:
        session = _session_for(request, term_id, data.get("projectPath"))
    except SessionEnded:
        return error(410, "Claude Code has ended.", kind="ended")
    except Exception as exc:
        return error(500, str(exc))
    if session is None:
        return error(400, "No active terminal session")
    action = data.get("action", "input")
    if action == "input":
        session.write(str(data.get("text", "")))
    elif action == "resize":
        try:
            session.resize(int(data.get("cols", 80)), int(data.get("rows", 24)))
        except (TypeError, ValueError):
            return error(400, "cols and rows must be integers")
    else:
        return error(400, "Invalid action")
    return web.json_response({"ok": True})


@routes.post("/api/terminal/start")
async def start(request: web.Request) -> web.Response:
    """Start (or restart) the shell of a tab."""
    data = await read_json(request)
    term_id, project_path = data.get("term_id"), data.get("projectPath")
    if not term_id or not project_path:
        return error(400, "term_id and projectPath required")
    if not _is_tab(term_id) or term_id == CLAUDE_ID:
        return error(400, "Unknown terminal id")
    if not os.path.isdir(project_path):
        return error(400, "Invalid project path")
    sessions = request.app[SESSIONS_KEY]
    try:
        session = TerminalSession(project_path)
        session.start_reading(asyncio.get_running_loop())
    except Exception as exc:
        return error(500, str(exc))
    previous = sessions.get(term_id)
    sessions[term_id] = session
    if previous is not None:
        previous.close()
    return web.json_response({"ok": True})


@routes.get("/api/terminal/output")
async def output(request: web.Request) -> web.Response:
    """What the main terminal shows, as plain text. Read-only: never starts a shell."""
    project_path = request.query.get("projectPath", "")
    if not project_path:
        return error(400, "projectPath parameter is required")
    session = request.app[SESSIONS_KEY].get(request.query.get("term_id", "main"))
    if session is None or not session.is_running:
        return error(404, "The terminal is not running.")
    if not _same_path(session.project_path, project_path):
        return error(409, f"The terminal belongs to another project ({session.project_path}).")
    backlog, _ = session.backlog_since(None)
    return web.json_response({"text": screen_text(backlog), "truncated": session.total_bytes > len(backlog)})
