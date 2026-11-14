"""Interface settings: language, appearance, workspace, client preferences,
and the model provider Claude Code uses (``model_provider.py``)."""

from __future__ import annotations

import aiohttp
from aiohttp import web

from gilzacode import model_provider, settings
from gilzacode.server.app import error, read_json
from gilzacode.server.routes_terminal import discard_claude_session

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


# ── The model provider ────────────────────────────────────────────────────────

#: How long GilzaCode waits for the Ollama server when listing its models.
OLLAMA_TIMEOUT_SECONDS = 5.0


@routes.get("/api/settings/model-provider")
async def get_model_provider(_request: web.Request) -> web.Response:
    try:
        provider = model_provider.load()
    except ValueError as exc:
        return error(500, f"The model provider saved in settings.json is not valid: {exc}", kind="config")
    return web.json_response({"provider": model_provider.public_view(provider),
                              "kinds": list(model_provider.KINDS),
                              "ollama_cloud_url": model_provider.OLLAMA_CLOUD_URL})


@routes.post("/api/settings/model-provider")
async def set_model_provider(request: web.Request) -> web.Response:
    """Store the provider and, when ``ollama_api_key`` is sent, the key ("" removes it).

    When that changes Claude Code's environment, the running session was started
    with the old one, so it is closed; the panel starts a new one (``restarted``
    says whether one was running).
    """
    data = await read_json(request)
    try:
        before = model_provider.current_environment()
    except ValueError:
        before = None  # an invalid stored provider or key: whatever replaces it is a change
    try:
        provider = model_provider.save(data)
        after = model_provider.current_environment()
    except ValueError as exc:
        return error(400, str(exc))
    restarted = discard_claude_session(request.app) if after != before else False
    return web.json_response({"success": True, "provider": model_provider.public_view(provider),
                              "restarted": restarted})


@routes.post("/api/settings/model-provider/ollama-models")
async def list_ollama_models(request: web.Request) -> web.Response:
    """The models the Ollama server at ``url`` offers (its ``/api/tags``).

    ``api_key``, when given, is sent as the bearer token. Without it, the stored
    key is sent only to the URL it was saved with, so testing another server
    never hands it the key. This lists models only; it sends no prompt
    (GilzaCode makes no model calls). It is a POST so the key stays out of URLs.
    """
    data = await read_json(request)
    try:
        url = model_provider.normalize_url(data.get("url", ""))
        if "api_key" in data:
            key = model_provider.normalize_api_key(data["api_key"])
        else:
            stored = model_provider.load()
            key = model_provider.load_api_key() if stored["ollama_url"].rstrip("/") == url else ""
    except ValueError as exc:
        return error(400, str(exc))
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    timeout = aiohttp.ClientTimeout(total=OLLAMA_TIMEOUT_SECONDS)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"{url}/api/tags", headers=headers) as response:
                if response.status in (401, 403):
                    return error(502, f"Ollama at {url} refused the request (HTTP {response.status}). "
                                 + ("Check the API key." if key else "It needs an API key."),
                                 kind="ollama_unauthorized")
                if response.status != 200:
                    return error(502, f"Ollama at {url} answered HTTP {response.status} to /api/tags.",
                                 kind="ollama_error")
                payload = await response.json(content_type=None)
    except TimeoutError:
        return error(504, f"Ollama at {url} did not answer within {OLLAMA_TIMEOUT_SECONDS:g} s.",
                     kind="ollama_unreachable")
    except aiohttp.ClientError as exc:
        return error(502, f"Could not reach Ollama at {url}: {exc}. Is Ollama running?",
                     kind="ollama_unreachable")
    except ValueError:
        return error(502, f"{url}/api/tags did not answer with JSON. Is this an Ollama server?",
                     kind="ollama_error")
    models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(models, list):
        return error(502, f"{url}/api/tags did not list models. Is this an Ollama server?", kind="ollama_error")
    listed = []
    for entry in models:
        name = entry.get("name") if isinstance(entry, dict) else None
        if not isinstance(name, str) or not name:
            continue
        details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
        capabilities = entry.get("capabilities")
        listed.append({
            "name": name,
            "parameter_size": str(details.get("parameter_size") or ""),
            "remote": bool(entry.get("remote_host")),
            # Claude Code works only through tools. Not every Ollama reports
            # capabilities here, so an absent list is "unknown" (None), not "no".
            "tools": ("tools" in capabilities) if isinstance(capabilities, list) else None,
        })
    return web.json_response({"url": url, "models": listed})
