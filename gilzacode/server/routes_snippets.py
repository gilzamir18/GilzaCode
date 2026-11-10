"""Translate and Look up an excerpt (contracts are GilzaBots'), through ``claude -p``."""

from __future__ import annotations

from aiohttp import web

from gilzacode import settings, snippets
from gilzacode.claude_cli import ClaudeCliError
from gilzacode.server.app import error, read_json

routes = web.RouteTableDef()

_CLI_STATUS = {"not_installed": 503, "timeout": 504, "failed": 502}


def _cli_error(exc: ClaudeCliError) -> web.Response:
    return web.json_response({"error": str(exc), "kind": exc.kind}, status=_CLI_STATUS.get(exc.kind, 500))


@routes.get("/api/settings/translation")
async def get_translation_settings(_request: web.Request) -> web.Response:
    return web.json_response({
        "translate_target_lang": str(settings.load().get("translate_target_lang", "") or ""),
        "known_languages": sorted(snippets.TRANSLATION_LANGUAGE_NAMES),
    })


@routes.post("/api/settings/translation")
async def set_translation_settings(request: web.Request) -> web.Response:
    data = await read_json(request)
    target = str(data.get("translate_target_lang", "") or "").strip()
    settings.save({"translate_target_lang": target})
    return web.json_response({"success": True, "translate_target_lang": target})


@routes.post("/api/translate")
async def translate(request: web.Request) -> web.Response:
    data = await read_json(request)
    text = str(data.get("text") or "")
    if not text.strip():
        return error(400, "text is required")
    cfg = settings.load()
    target = snippets.resolve_target_language(data.get("target_lang"), cfg.get("translate_target_lang"), cfg.get("lang"))
    try:
        translated = await snippets.translate(text, target, model=str(data.get("model") or "").strip())
    except ValueError as exc:
        return error(400, str(exc))
    except ClaudeCliError as exc:
        return _cli_error(exc)
    return web.json_response({"success": True, "target_language": target, "translated_text": translated})


@routes.post("/api/snippet-query")
async def snippet_query(request: web.Request) -> web.Response:
    data = await read_json(request)
    excerpt, question = str(data.get("excerpt") or ""), str(data.get("question") or "")
    if not excerpt.strip() or not question.strip():
        return error(400, "excerpt and question are required")
    try:
        result = await snippets.look_up(
            excerpt, question, snippets.SnippetQuerySource.from_payload(data.get("source")),
            project_path=str(data.get("projectPath") or "").strip() or None,
            model=str(data.get("model") or "").strip(),
        )
    except ValueError as exc:
        return error(400, str(exc))
    except ClaudeCliError as exc:
        return _cli_error(exc)
    return web.json_response({"success": True, "answer": result.answer, "truncated": result.truncated,
                              "files_read": result.files_read})
