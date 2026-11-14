"""The Claude Code panel: whether `claude` is available, (re)starting it, pasting into it,
and installing the GilzaCode skills plugin (``claude_plugins.py``).

The session itself is a PTY with the terminal id ``claude`` (``routes_terminal.py``),
so the panel streams and types through the terminal endpoints.

**Pasting never submits.** Staged text is sent as one bracketed paste
(``ESC[200~ … ESC[201~``), which Claude Code puts in its composer; the user
reviews it and presses Enter (PROJECT_DESIGN.md §2). Every ESC is removed from
the text first: an excerpt from a PDF could otherwise carry ``ESC[201~`` and turn
what follows it into keystrokes, Enter included.
"""

from __future__ import annotations

import asyncio
import time

from aiohttp import web

from gilzacode import claude_cli, claude_plugins
from gilzacode.claude_cli import ClaudeCliError, find_claude
from gilzacode.server.app import error, read_json
from gilzacode.server.routes_terminal import CLAUDE_ID, SESSIONS_KEY, _same_path, _session_for

routes = web.RouteTableDef()

#: Output must have been quiet this long before a paste is typed, so it does not
#: land in the middle of Claude Code redrawing its screen.
PASTE_IDLE_SECONDS = 0.6
PASTE_WAIT_SECONDS = 5.0
MAX_PASTE_CHARS = 100_000


def bracketed_paste(text: str) -> str:
    clean = str(text).replace("\x1b", "").replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r")
    return f"\x1b[200~{clean}\x1b[201~"


def _status(request: web.Request, project_path: str) -> dict:
    try:
        find_claude()
        problem, problem_kind = "", ""
    except ClaudeCliError as exc:
        problem, problem_kind = str(exc), exc.kind
    session = request.app[SESSIONS_KEY].get(CLAUDE_ID)
    mine = session is not None and bool(project_path) and _same_path(session.project_path, project_path)
    now = time.monotonic()
    return {
        "available": not problem,
        "problem": problem,
        "problem_kind": problem_kind,
        "running": bool(mine and session.is_running),
        "exited": bool(mine and session.exited),
        "uptime_ms": int((now - session.started_at) * 1000) if mine else 0,
        "idle_ms": int((now - session.last_output_at) * 1000) if mine else 0,
    }


@routes.get("/api/claude/status")
async def status(request: web.Request) -> web.Response:
    return web.json_response(_status(request, request.query.get("projectPath", "")))


@routes.post("/api/claude/start")
async def start(request: web.Request) -> web.Response:
    """Start Claude Code in the project, replacing an exited session."""
    data = await read_json(request)
    project_path = data.get("projectPath") or ""
    try:
        session = _session_for(request, CLAUDE_ID, project_path, restart=True)
    except ClaudeCliError as exc:
        return error(503, str(exc), kind=exc.kind)
    except Exception as exc:  # the PTY could not be created
        return error(500, f"Failed to start Claude Code: {exc}")
    if session is None:
        return error(400, "A valid projectPath is required")
    return web.json_response(_status(request, project_path))


@routes.post("/api/claude/paste")
async def paste(request: web.Request) -> web.Response:
    """Paste `text` into Claude Code's composer, unsent."""
    data = await read_json(request)
    project_path, text = data.get("projectPath") or "", data.get("text")
    if not isinstance(text, str) or not text.strip():
        return error(400, "text is required")
    if len(text) > MAX_PASTE_CHARS:
        return error(400, f"The text is too long to paste ({len(text)} characters, limit {MAX_PASTE_CHARS}).")
    session = request.app[SESSIONS_KEY].get(CLAUDE_ID)
    if session is None or not session.is_running or not project_path or not _same_path(session.project_path, project_path):
        return error(409, "Claude Code is not running in this project.", kind="not_running")
    deadline = time.monotonic() + PASTE_WAIT_SECONDS
    while time.monotonic() - session.last_output_at < PASTE_IDLE_SECONDS:
        if time.monotonic() > deadline:
            return error(409, "Claude Code is busy; paste again when it is idle.", kind="busy")
        await asyncio.sleep(0.1)
    session.write(bracketed_paste(text))
    return web.json_response({"pasted": True})


# ── The Claude Code CLI itself (Settings > Dependencies, the panel) ──────────

#: The request currently running the installer, so a second click does not
#: start a second installer over the first.
_installing = False


def _cli_status() -> dict:
    command_argv, command = claude_cli.install_command()
    try:
        path, problem, kind = find_claude(), "", ""
    except ClaudeCliError as exc:
        path, problem, kind = "", str(exc), exc.kind
    return {
        "available": bool(path),
        "path": path,
        "problem": problem,
        "problem_kind": kind,
        "desktop_app_installed": claude_cli.desktop_app_installed(),
        "install_command": command,
        "install_shell": "PowerShell" if command_argv[0].lower().startswith("powershell") else "bash",
        "guide_url": claude_cli.INSTALL_GUIDE_URL,
        "installing": _installing,
    }


@routes.get("/api/claude/cli")
async def cli_status(_request: web.Request) -> web.Response:
    return web.json_response(_cli_status())


@routes.post("/api/claude/cli/install")
async def install_cli(_request: web.Request) -> web.Response:
    """Run Anthropic's native installer for the Claude Code CLI (an explicit click)."""
    global _installing
    if _installing:
        return error(409, "The Claude Code installer is already running.", kind="busy")
    _installing = True
    try:
        result = await claude_cli.install_cli()
    except ClaudeCliError as exc:
        return error(504 if exc.kind == "timeout" else 502, str(exc), kind=exc.kind)
    finally:
        _installing = False
    return web.json_response({**_cli_status(), "output": result["output"]})


# ── The GilzaCode skills (a Claude Code plugin) ──────────────────────────────

_PLUGIN_ERROR_STATUS = {"not_installed": 503, "timeout": 504}


def _plugin_error(exc: ClaudeCliError) -> web.Response:
    return error(_PLUGIN_ERROR_STATUS.get(exc.kind, 502), str(exc), kind=exc.kind)


@routes.get("/api/claude/skills")
async def skills_status(_request: web.Request) -> web.Response:
    try:
        return web.json_response(await claude_plugins.skills_status())
    except ClaudeCliError as exc:
        return _plugin_error(exc)


@routes.post("/api/claude/skills/install")
async def install_skills(_request: web.Request) -> web.Response:
    try:
        return web.json_response(await claude_plugins.install_skills())
    except ClaudeCliError as exc:
        return _plugin_error(exc)


@routes.post("/api/claude/skills/update")
async def update_skills(_request: web.Request) -> web.Response:
    try:
        return web.json_response(await claude_plugins.update_skills())
    except ClaudeCliError as exc:
        return _plugin_error(exc)
