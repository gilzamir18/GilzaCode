"""Inline edits (``gilzacode/inline_edit.py``): Refine, Generate content, Create illustration."""

from __future__ import annotations

from aiohttp import web

from gilzacode import inline_edit
from gilzacode.claude_cli import ClaudeCliError
from gilzacode.server.app import error, read_json
from gilzacode.server.routes_cloud import notify_change

routes = web.RouteTableDef()

# The model call does not hold the ordering lock: the edit is written by the
# editor, and an illustration is a new file no save can collide with.
_CLI_STATUS = {"not_installed": 503, "timeout": 504, "failed": 502}
_STATUS = {"invalid": 400, "too_large": 413, "invalid_answer": 502, "write_failed": 500}


@routes.post("/api/inline-edit")
async def inline_edit_route(request: web.Request) -> web.Response:
    data = await read_json(request)
    try:
        req = inline_edit.Request.from_payload(data)
        result = await inline_edit.run(req, model=str(data.get("model") or "").strip())
    except inline_edit.InlineEditError as exc:
        return error(_STATUS.get(exc.code, 400), str(exc), code=exc.code)
    except ClaudeCliError as exc:
        return web.json_response({"error": str(exc), "kind": exc.kind}, status=_CLI_STATUS.get(exc.kind, 500))
    if "svg_path" in result:
        notify_change(req.project)
    return web.json_response({"success": True, **result})
