"""Change .tex (``gilzacode/tex_change.py``): propose through ``claude -p``, apply on confirmation."""

from __future__ import annotations

import asyncio

from aiohttp import web

from gilzacode import tex_change
from gilzacode.claude_cli import ClaudeCliError
from gilzacode.server.app import EXCLUSIVE_WORK_PATHS, error, read_json
from gilzacode.server.routes_cloud import notify_change

routes = web.RouteTableDef()

# Applying writes a source file: it keeps arrival order with the editor's saves
# and compiles. Proposing only reads, and a model call must not hold the lock.
EXCLUSIVE_WORK_PATHS.add("/api/tex-change/apply")

_CLI_STATUS = {"not_installed": 503, "timeout": 504, "failed": 502}
_STATUS = {"invalid": 400, "no_source": 409, "no_synctex": 409, "no_line": 409, "two_files": 409,
           "stale": 409, "invalid_answer": 502, "write_failed": 500}


def _refusal(exc: tex_change.TexChangeError) -> web.Response:
    return error(_STATUS.get(exc.code, 400), str(exc), code=exc.code)


@routes.post("/api/tex-change/propose")
async def propose(request: web.Request) -> web.Response:
    data = await read_json(request)
    try:
        anchors = [tex_change.Anchor.from_payload(item) for item in (data.get("anchors") or [])]
        page = data.get("page")
        result = await tex_change.propose(
            project_path=str(data.get("projectPath") or "").strip(),
            pdf_path=str(data.get("pdfPath") or "").strip(),
            excerpt=str(data.get("excerpt") or ""),
            anchors=anchors,
            turns=data.get("turns"),
            page=int(page) if isinstance(page, int) and page > 0 else None,
            model=str(data.get("model") or "").strip(),
        )
    except tex_change.TexChangeError as exc:
        return _refusal(exc)
    except ClaudeCliError as exc:
        return web.json_response({"error": str(exc), "kind": exc.kind}, status=_CLI_STATUS.get(exc.kind, 500))
    return web.json_response({"success": True, **result})


@routes.post("/api/tex-change/apply")
async def apply(request: web.Request) -> web.Response:
    data = await read_json(request)
    project_path = str(data.get("projectPath") or "").strip()
    file_path = str(data.get("file") or "").strip()
    if not project_path or not file_path:
        return error(400, "projectPath and file are required")
    try:
        content = await asyncio.to_thread(tex_change.apply, project_path, file_path, data.get("edits"))
    except tex_change.TexChangeError as exc:
        return _refusal(exc)
    notify_change(project_path)
    return web.json_response({"success": True, "file": file_path, "content": content})
