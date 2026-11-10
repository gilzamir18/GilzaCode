"""Interface settings: language, appearance, workspace, client preferences."""

from __future__ import annotations

from aiohttp import web

from gilzacode import settings
from gilzacode.server.app import error, read_json

routes = web.RouteTableDef()


@routes.get("/api/settings/language")
async def get_language(_request: web.Request) -> web.Response:
    return web.json_response({"lang": settings.load().get("lang", "")})


@routes.post("/api/settings/language")
async def set_language(request: web.Request) -> web.Response:
    data = await read_json(request)
    lang = data.get("lang", "")
    if not isinstance(lang, str):
        return error(400, "lang must be a string")
    settings.save({"lang": lang})
    return web.json_response({"success": True})


@routes.get("/api/settings/appearance")
async def get_appearance(_request: web.Request) -> web.Response:
    return web.json_response({
        "ui_scale": settings.clamp_ui_scale(settings.load().get("ui_scale", 1.0)),
        "ui_scale_min": settings.UI_SCALE_MIN,
        "ui_scale_max": settings.UI_SCALE_MAX,
    })


@routes.post("/api/settings/appearance")
async def set_appearance(request: web.Request) -> web.Response:
    data = await read_json(request)
    scale = settings.clamp_ui_scale(data.get("ui_scale", 1.0))
    settings.save({"ui_scale": scale})
    return web.json_response({"success": True, "ui_scale": scale})


@routes.get("/api/settings/workspace")
async def get_workspace(_request: web.Request) -> web.Response:
    return web.json_response({
        "show_hidden_workspace_files": bool(settings.load().get("show_hidden_workspace_files", False)),
        "hidden_file_extensions": settings.hidden_file_extensions(),
    })


@routes.post("/api/settings/workspace")
async def set_workspace(request: web.Request) -> web.Response:
    data = await read_json(request)
    show = bool(data.get("show_hidden_workspace_files", False))
    settings.save({"show_hidden_workspace_files": show})
    return web.json_response({
        "success": True,
        "show_hidden_workspace_files": show,
        "hidden_file_extensions": settings.hidden_file_extensions(),
    })


@routes.get("/api/settings/client-prefs")
async def get_client_prefs(_request: web.Request) -> web.Response:
    return web.json_response(settings.load_client_prefs())


@routes.post("/api/settings/client-prefs")
async def set_client_prefs(request: web.Request) -> web.Response:
    """``{"set": {key: value}, "remove": [key], "legacy_import": bool}``, string keys and values."""
    data = await read_json(request)
    try:
        applied = settings.update_client_prefs(data.get("set", {}), data.get("remove", []),
                                               legacy_import=bool(data.get("legacy_import", False)))
    except ValueError as exc:
        return error(400, str(exc))
    return web.json_response({"success": True, "applied": applied})
