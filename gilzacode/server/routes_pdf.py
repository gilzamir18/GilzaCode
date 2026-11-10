"""Annotations stored natively inside standalone PDFs (``gilzacode/pdf_annotations.py``).

Contracts are GilzaBots'. Writes rewrite the PDF file, so they are exclusive
work: two edits to the same file never run at the same time, and they run in a
worker thread instead of on the event loop.
"""

from __future__ import annotations

import asyncio

from aiohttp import web

from gilzacode.files import PathOutsideProject, resolve
from gilzacode.server.app import EXCLUSIVE_WORK_PATHS, error, read_json

routes = web.RouteTableDef()

EXCLUSIVE_WORK_PATHS.update({"/api/pdf/annotations", "/api/pdf/annotations/update",
                             "/api/pdf/annotations/marker", "/api/pdf/annotations/delete"})


def _target(project_path, file_path) -> str | web.Response:
    if not project_path or not file_path:
        return error(400, "projectPath and filePath are required")
    try:
        return resolve(project_path, file_path, allow_root=False)
    except PathOutsideProject:
        return error(403, "Forbidden: Path traversal detected")


async def _run(work) -> web.Response:
    from gilzacode.pdf_annotations import PdfAnnotationError
    try:
        return web.json_response(await asyncio.to_thread(work))
    except PdfAnnotationError as exc:
        # The request was well-formed; the message names a condition the user can act on.
        return error(409, str(exc))
    except (TypeError, ValueError) as exc:
        return error(400, str(exc))


@routes.get("/api/pdf/annotations")
async def list_annotations(request: web.Request) -> web.Response:
    from gilzacode import pdf_annotations as pa
    target = _target(request.query.get("projectPath"), request.query.get("filePath"))
    if isinstance(target, web.Response):
        return target
    return await _run(lambda: {"success": True, "annotations": pa.list_annotations(target)})


@routes.get("/api/pdf/annotations/document")
async def document_without_annotations(request: web.Request) -> web.Response:
    """A copy of the PDF with its annotations removed, for the viewer's "hide" toggle.

    pdf.js paints annotations into the page canvas and react-pdf cannot turn that
    off. The file on disk is untouched.
    """
    from gilzacode.pdf_annotations import PdfAnnotationError, read_without_annotations
    target = _target(request.query.get("projectPath"), request.query.get("filePath"))
    if isinstance(target, web.Response):
        return target
    try:
        body = await asyncio.to_thread(read_without_annotations, target)
    except PdfAnnotationError as exc:
        return error(409, str(exc))
    return web.Response(body=body, content_type="application/pdf")


@routes.post("/api/pdf/annotations")
async def add_annotation(request: web.Request) -> web.Response:
    from gilzacode import pdf_annotations as pa
    data = await read_json(request)
    target = _target(data.get("projectPath"), data.get("filePath"))
    if isinstance(target, web.Response):
        return target
    return await _run(lambda: {"success": True, "annotation": pa.add_annotation(
        target, page=int(data.get("page") or 0), kind=str(data.get("kind") or ""), rects=data.get("rects") or [],
        color=str(data.get("color") or "") or pa.DEFAULT_COLOR, content=str(data.get("content") or ""),
        author=str(data.get("author") or "") or pa.DEFAULT_AUTHOR)})


@routes.post("/api/pdf/annotations/update")
async def update_annotation(request: web.Request) -> web.Response:
    from gilzacode import pdf_annotations as pa
    data = await read_json(request)
    target = _target(data.get("projectPath"), data.get("filePath"))
    if isinstance(target, web.Response):
        return target
    return await _run(lambda: {"success": True, "annotation": pa.update_annotation(
        target, int(data.get("id") or 0), content=data.get("content"), color=data.get("color"))})


@routes.post("/api/pdf/annotations/marker")
async def move_marker(request: web.Request) -> web.Response:
    from gilzacode import pdf_annotations as pa
    data = await read_json(request)
    target = _target(data.get("projectPath"), data.get("filePath"))
    if isinstance(target, web.Response):
        return target
    return await _run(lambda: {"success": True, "annotation": pa.move_annotation_marker(
        target, int(data.get("id") or 0), data.get("point") or [])})


@routes.post("/api/pdf/annotations/delete")
async def delete_annotation(request: web.Request) -> web.Response:
    from gilzacode import pdf_annotations as pa
    data = await read_json(request)
    target = _target(data.get("projectPath"), data.get("filePath"))
    if isinstance(target, web.Response):
        return target
    return await _run(lambda: {"success": True, "deleted": pa.delete_annotation(target, int(data.get("id") or 0))})
