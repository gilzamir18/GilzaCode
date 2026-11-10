"""Pronouncing an excerpt, its settings, and the downloadable Piper voices.

Contracts are GilzaBots' (local engine only; see ``gilzacode/speech/config.py``).
"""

from __future__ import annotations

import asyncio

from aiohttp import web

from gilzacode.server.app import error, read_json
from gilzacode.speech import config as speech_config
from gilzacode.speech import voice_store
from gilzacode.speech.errors import SpeechSynthesisError

routes = web.RouteTableDef()

_SPEECH_STATUS = {"bad_request": 400, "too_long": 400, "not_configured": 503, "unavailable": 503}
_VOICE_STATUS = {"bad_request": 400, "not_found": 404, "connection": 503, "corrupt": 502}


def _settings_payload() -> dict:
    return {**speech_config.load_config(), "engines": list(speech_config.ENGINES), "models": [],
            "problem": speech_config.configuration_problem()}


@routes.get("/api/settings/speech")
async def get_speech_settings(_request: web.Request) -> web.Response:
    """The settings plus ``problem``: "" when Pronounce is ready, else why it is not."""
    return web.json_response(await asyncio.to_thread(_settings_payload))


@routes.post("/api/settings/speech")
async def set_speech_settings(request: web.Request) -> web.Response:
    data = await read_json(request)
    try:
        speech_config.save_config(data)
    except ValueError as exc:
        return error(400, str(exc))
    return web.json_response({"success": True, **await asyncio.to_thread(_settings_payload)})


@routes.post("/api/speech")
async def speak(request: web.Request) -> web.Response:
    """The audio of an excerpt, as the response body (``audio/wav``)."""
    data = await read_json(request)
    text = str(data.get("text") or "")
    if not text.strip():
        return error(400, "text is required")
    problem = await asyncio.to_thread(speech_config.configuration_problem)
    if problem:
        return web.json_response({"error": problem, "kind": "not_configured"}, status=503)
    try:
        audio, mime = await asyncio.to_thread(speech_config.synthesize, text, data.get("speed"))
    except ValueError as exc:
        return web.json_response({"error": str(exc), "kind": "bad_request"}, status=400)
    except SpeechSynthesisError as exc:
        return web.json_response({"error": str(exc), "kind": exc.kind}, status=_SPEECH_STATUS.get(exc.kind, 500))
    return web.Response(body=audio, content_type=mime)


def _voice_error(exc: Exception) -> web.Response:
    kind = getattr(exc, "kind", "unknown")
    return web.json_response({"error": str(exc), "kind": kind}, status=_VOICE_STATUS.get(kind, 500))


@routes.get("/api/speech/voices")
async def list_voices(request: web.Request) -> web.Response:
    from gilzacode.speech.phonemes import availability_problem
    refresh = request.query.get("refresh", "0") in ("1", "true")
    installed = voice_store.installed_voices()
    try:
        catalog, catalog_error = await asyncio.to_thread(voice_store.list_catalog, refresh), ""
    except voice_store.VoiceStoreError as exc:
        # Offline must not empty the list of what is installed: the engine works without a network.
        catalog, catalog_error = [], str(exc)
    return web.json_response({
        "catalog": catalog, "catalog_error": catalog_error, "installed": installed,
        "selected": str(speech_config.load_config().get("local_voice", "") or ""),
        "downloads": voice_store.download_progress(), "phonemizer_problem": availability_problem(),
    })


@routes.post("/api/speech/voices/download")
async def download_voice(request: web.Request) -> web.Response:
    data = await read_json(request)
    key = str(data.get("key") or "").strip()
    if voice_store.is_downloading(key):
        return web.json_response({"error": f"'{key}' is already downloading.", "kind": "busy"}, status=409)
    try:
        summary = await asyncio.to_thread(voice_store.download_voice, key)
    except voice_store.VoiceStoreError as exc:
        return _voice_error(exc)
    return web.json_response({"success": True, "voice": summary, "installed": voice_store.installed_voices()})


@routes.post("/api/speech/voices/remove")
async def remove_voice(request: web.Request) -> web.Response:
    data = await read_json(request)
    key = str(data.get("key") or "").strip()
    try:
        voice_store.remove_voice(key)
    except voice_store.VoiceStoreError as exc:
        return _voice_error(exc)
    voice_store.clear_download_progress(key)
    cfg = speech_config.load_config()
    if cfg.get("local_voice") == key:
        # A configuration naming a voice that is gone would fail at synthesis time.
        speech_config.save_config({**cfg, "local_voice": ""})
    return web.json_response({"success": True, "installed": voice_store.installed_voices()})
