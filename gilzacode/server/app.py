"""The loopback HTTP server: the session boundary, request ordering, static files.

Request ordering is GilzaBots' (§2.1, ``EXCLUSIVE_WORK_PATHS``): slow work such as
walking the project tree runs in a worker thread so streams keep flowing, but
while it runs it holds an ordering lock that every other request waits on before
it is dispatched. Requests are therefore still handled in arrival order and never
interleave with that work — a save that arrives during a compile lands after it.
Streaming endpoints register with `STREAMING_PATHS` and skip the wait, since a
stream that waited behind itself would never start.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from aiohttp import web

from gilzacode.session import BOOTSTRAP_HEADER, LocalSession

SESSION_KEY = web.AppKey("session", LocalSession)
ORDER_LOCK_KEY = web.AppKey("order_lock", asyncio.Lock)
STATIC_DIR_KEY = web.AppKey("static_dir", object)

#: Requests whose whole handling holds the ordering lock.
EXCLUSIVE_WORK_PATHS: set[str] = {"/api/files"}

#: Long-lived responses that must not wait on the ordering lock.
STREAMING_PATHS: set[str] = set()

#: Largest request body: a source file being saved or a file being imported.
CLIENT_MAX_SIZE = 256 * 1024 * 1024

_SECURITY_HEADERS = {
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "frame-ancestors 'self'",
    "X-Content-Type-Options": "nosniff",
}


def error(status: int, message: str, **extra) -> web.Response:
    return web.json_response({"error": message, **extra}, status=status)


async def read_json(request: web.Request) -> dict:
    """The JSON object in the body; a missing or malformed body reads as ``{}``."""
    if not request.can_read_body:
        return {}
    try:
        data = await request.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


@web.middleware
async def session_middleware(request: web.Request, handler):
    session = request.app[SESSION_KEY]
    if not session.trusted_request(request.headers):
        return error(403, "Untrusted request origin or host.")
    path = request.path
    if path == "/api/session" and request.method == "POST":
        if request.headers.get(BOOTSTRAP_HEADER) != "1":
            return error(403, "Invalid session bootstrap.")
        response = web.json_response({"success": True})
        response.headers["Set-Cookie"] = session.cookie_header()
        return response
    if path.startswith("/api/") and not session.authenticated(request.headers):
        return error(401, "Local session required. Reload the application.")
    return await handler(request)


@web.middleware
async def ordering_middleware(request: web.Request, handler):
    lock = request.app[ORDER_LOCK_KEY]
    if request.path in STREAMING_PATHS:
        return await handler(request)
    if request.path in EXCLUSIVE_WORK_PATHS:
        async with lock:
            return await handler(request)
    # Wait for exclusive work already queued; an uncontended acquire does not yield.
    async with lock:
        pass
    return await handler(request)


@web.middleware
async def headers_middleware(request: web.Request, handler):
    try:
        response = await handler(request)
    except web.HTTPException as exc:
        response = exc
    if not response.prepared:
        response.headers.update(_SECURITY_HEADERS)
        if request.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
    return response


async def session_check(_request: web.Request) -> web.Response:
    return web.json_response({"success": True})


def _static_handler(static_dir: Path | None):
    async def serve(request: web.Request) -> web.StreamResponse:
        if static_dir is None:
            return web.Response(status=404, text="The interface is not built.")
        rel = request.match_info.get("tail", "") or "index.html"
        full = (static_dir / rel).resolve()
        root = static_dir.resolve()
        if root not in full.parents and full != root:
            return web.Response(status=403, text="Forbidden")
        if not full.is_file():
            full = root / "index.html"  # single-page application fallback
            if not full.is_file():
                return web.Response(status=404, text="Not Found")
        return web.FileResponse(full)

    return serve


def default_static_dir() -> Path | None:
    candidate = Path(__file__).resolve().parent.parent / "static"
    return candidate if (candidate / "index.html").is_file() else None


def create_app(session: LocalSession, static_dir: Path | None = None) -> web.Application:
    from gilzacode.server import routes_files, routes_projects, routes_settings, routes_system

    app = web.Application(
        middlewares=[headers_middleware, session_middleware, ordering_middleware],
        client_max_size=CLIENT_MAX_SIZE,
    )
    app[SESSION_KEY] = session
    app[ORDER_LOCK_KEY] = asyncio.Lock()
    app[STATIC_DIR_KEY] = static_dir
    app.router.add_get("/api/session", session_check)
    for module in (routes_files, routes_projects, routes_settings, routes_system):
        app.router.add_routes(module.routes)
    # Anything else under /api/ is an unknown endpoint, not the SPA fallback.
    app.router.add_route("*", "/api/{tail:.*}", unknown_endpoint)
    app.router.add_get("/{tail:.*}", _static_handler(static_dir))
    return app


async def unknown_endpoint(_request: web.Request) -> web.Response:
    return error(404, "Unknown endpoint.")
