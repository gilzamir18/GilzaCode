"""Clipboard, opening web links, and the application environment."""

from __future__ import annotations

import asyncio
import platform
import sys
import webbrowser
from urllib.parse import urlparse

from aiohttp import web

from gilzacode import __version__
from gilzacode.server.app import error, read_json

routes = web.RouteTableDef()


def _clipboard():
    if sys.platform != "win32":
        raise OSError("The clipboard is implemented for Windows only.")
    from gilzacode import win_clipboard
    return win_clipboard


@routes.get("/api/clipboard/read")
async def clipboard_read(_request: web.Request) -> web.Response:
    try:
        text = await asyncio.to_thread(_clipboard().read_text)
    except OSError as exc:
        return error(500, str(exc))
    return web.json_response({"text": text})


@routes.get("/api/clipboard/read-image")
async def clipboard_read_image(_request: web.Request) -> web.Response:
    try:
        image = await asyncio.to_thread(_clipboard().read_image_png_b64)
    except OSError as exc:
        return error(500, str(exc))
    return web.json_response({"data_b64": image or None, "mime": "image/png" if image else None})


@routes.post("/api/clipboard/write")
async def clipboard_write(request: web.Request) -> web.Response:
    data = await read_json(request)
    text = data.get("text", "")
    if not isinstance(text, str):
        return error(400, "text must be a string")
    try:
        await asyncio.to_thread(_clipboard().write_text, text)
    except OSError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)
    return web.json_response({"ok": True})


@routes.post("/api/system/open-url")
async def open_url(request: web.Request) -> web.Response:
    """Open an http(s) link in the default browser; no other scheme is accepted.

    Handing an arbitrary scheme to the shell would mean "run whatever the page asks for".
    """
    data = await read_json(request)
    url = str(data.get("url", "") or "").strip()
    if urlparse(url).scheme.lower() not in {"http", "https"}:
        return error(400, "Only http and https URLs can be opened.")
    try:
        opened = await asyncio.to_thread(webbrowser.open, url, 1, True)
    except Exception as exc:  # webbrowser raises assorted errors per platform
        return web.json_response({"opened": False, "error": str(exc)})
    return web.json_response({"opened": bool(opened)})


@routes.get("/api/app/environment")
async def environment(_request: web.Request) -> web.Response:
    return web.json_response({"platform": platform.system(), "version": __version__})
