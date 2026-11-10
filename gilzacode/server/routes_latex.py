"""LaTeX: compile with Tectonic, serve the PDF, SyncTeX, previews, DOCX export, tool installs.

Ported from GilzaBots' ``ide_server.py`` with the same contracts. The compiler
itself (``gilzacode/latex_compiler.py``) is GilzaBots' module, copied.

The server remembers the last compiled PDF and its SyncTeX file
(`LatexState`), as GilzaBots did: ``/api/latex/pdf`` serves it, and forward
search uses its SyncTeX before the main file's default one.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass

from aiohttp import web

from gilzacode import projects, settings
from gilzacode.files import is_within
from gilzacode.server.app import EXCLUSIVE_WORK_PATHS, error, read_json

routes = web.RouteTableDef()

# Tectonic runs for seconds (minutes on a first compile that fetches its bundle):
# it runs in a worker thread while every other request waits, in arrival order.
EXCLUSIVE_WORK_PATHS.update({"/api/latex/compile", "/api/latex/compile-pdf-source"})

COMPILE_DEBUG_VERSION = "gilzacode-1"
TECTONIC_URL_WINDOWS = ("https://github.com/tectonic-typesetting/tectonic/releases/download/"
                        "tectonic%400.15.0/tectonic-0.15.0-x86_64-pc-windows-msvc.zip")


@dataclass
class LatexState:
    pdf_path: str = ""
    synctex_path: str = ""

    def remember(self, result: dict) -> None:
        if result.get("success") and result.get("pdf_path"):
            self.pdf_path = result["pdf_path"]
            self.synctex_path = result.get("synctex_path", "")
        else:
            self.pdf_path = self.synctex_path = ""


STATE_KEY = web.AppKey("latex_state", LatexState)


def setup(app: web.Application) -> None:
    app[STATE_KEY] = LatexState()


def _state(request: web.Request) -> LatexState:
    return request.app[STATE_KEY]


def _synctex_in_draft() -> bool:
    return bool(settings.load().get("draft_synctex_enabled", False))


def _registered_main_file(project_path: str, project_name: str = "") -> str:
    """The main file the user set for this project, by key or by folder."""
    try:
        registered = projects.list_projects()
    except projects.ProjectError:
        return ""
    target = os.path.normcase(os.path.abspath(os.path.expanduser(project_path)))
    for project in registered:
        same_name = bool(project_name) and project.name.casefold() == project_name.casefold()
        same_path = os.path.normcase(os.path.abspath(project.project_path)) == target
        if same_name or same_path:
            return project.main_file
    return ""


def _resolve_main_file(project_path: str, full_path: str, content: str, preselected: str) -> str:
    from gilzacode.latex_compiler import determine_main_file_for_compilation
    return determine_main_file_for_compilation(full_path, content, project_path, preselected)


def _relpath(path: str, root: str) -> str:
    try:
        return os.path.relpath(path, root).replace("\\", "/")
    except ValueError:
        return path


def _write_compile_debug(project_path: str, payload: dict) -> str:
    """Persist the last compile decision in ``<project>/.gilzacode/`` for diagnostics."""
    if not project_path:
        return ""
    path = os.path.join(project_path, ".gilzacode", "latex_compile_debug.json")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
        return path
    except OSError:
        return ""


def _format_compile_debug(payload: dict) -> str:
    lines = ["GilzaCode LaTeX Debug"]
    for key in ("debug_version", "partial", "request_file_path", "resolved_full_path", "project_path",
                "requested_main_file", "store_main_file", "selected_main_file", "selected_main_exists",
                "selected_main_reason", "compile_function", "partial_mode", "compiler_cwd",
                "compiler_input_tex", "compiler_returncode", "pdf_path", "debug_file"):
        if key in payload:
            lines.append(f"{key}: {payload.get(key)}")
    return "\n".join(lines)


class CompileRequestError(ValueError):
    """A compile request missing what it needs."""


@routes.post("/api/latex/compile")
async def compile_document(request: web.Request) -> web.Response:
    """Compile the editor's buffer: the whole document, a draft, or the edited part only."""
    try:
        result = await run_compile(request.app, await read_json(request))
    except CompileRequestError as exc:
        return error(400, str(exc))
    return web.json_response(result)


async def run_compile(app: web.Application, data: dict) -> dict:
    """The compile behind ``/api/latex/compile``, shared with the MCP tool (``routes_ide``).

    `data` has the endpoint's fields. Remembers the PDF for ``/api/latex/pdf``.
    """
    from gilzacode import latex_compiler
    started = time.perf_counter()
    content = data.get("content", "")
    file_path = data.get("filePath", "")
    project_path = data.get("projectPath", "")
    project_name = str(data.get("projectName", "") or "").strip()
    requested_main = str(data.get("mainFile", "") or "").strip()
    partial = bool(data.get("partial", False))
    draft = bool(data.get("draft", False))
    synctex = (not draft) or _synctex_in_draft()
    if not content:
        raise CompileRequestError("content is required")

    debug = {"debug_version": COMPILE_DEBUG_VERSION, "partial": partial, "draft": draft,
             "synctex_enabled": synctex, "request_file_path": file_path, "project_path": project_path,
             "project_name": project_name, "requested_main_file": requested_main,
             "content_is_independent": latex_compiler.is_independent(content)}
    full_path = ""
    if file_path:
        if os.path.isabs(file_path):
            full_path = os.path.abspath(file_path)
        elif project_path:
            full_path = os.path.abspath(os.path.join(project_path, file_path))
    if not project_path and full_path:
        project_path = os.path.dirname(full_path)
        debug["project_path_inferred_from_file"] = project_path
    debug.update(project_path=project_path, resolved_full_path=full_path,
                 resolved_full_exists=bool(full_path and os.path.exists(full_path)))

    main_file, reason = "", "unresolved"
    if project_path:
        if requested_main:
            candidate = os.path.abspath(os.path.join(project_path, requested_main))
            if is_within(candidate, project_path) and os.path.isfile(candidate):
                main_file, reason = os.path.relpath(candidate, os.path.abspath(project_path)), "request.mainFile"
        store_main = ""
        if not main_file:
            store_main = _registered_main_file(project_path, project_name)
            if store_main:
                main_file, reason = store_main, "project_registry"
        preselected = main_file
        main_file = _resolve_main_file(project_path, full_path, content, main_file)
        if main_file != preselected:
            reason = "determine_main_file_for_compilation"
        selected_abs = os.path.abspath(os.path.join(project_path, main_file)) if main_file else ""
        debug.update(store_main_file=store_main, preselected_main_file=preselected, selected_main_file=main_file,
                     selected_main_reason=reason, selected_main_abs=selected_abs,
                     selected_main_exists=bool(selected_abs and os.path.isfile(selected_abs)),
                     selected_main_rel=_relpath(selected_abs, project_path) if selected_abs else "")

    def run() -> dict:
        kwargs = dict(include_pdf_base64=False, draft=draft, synctex=synctex)
        if not partial:
            debug["compile_function"] = "compile_latex"
            return latex_compiler.compile_latex(content, full_path, main_file, project_path, **kwargs)
        debug["compile_function"] = "compile_latex_partial"
        result = latex_compiler.compile_latex_partial(content, full_path, main_file, project_path, **kwargs)
        debug["partial_mode"] = result.get("partial_mode", "")
        if result.get("success"):
            return result
        partial_log = result.get("log") or "Partial compilation failed."
        debug["partial_fallback_reason"] = partial_log[:2000]
        debug["compile_function"] = "compile_latex_partial_then_compile_latex"
        fallback = latex_compiler.compile_latex(content, full_path, main_file, project_path, **kwargs)
        fallback["partial_fallback_reason"] = partial_log
        if not fallback.get("success"):
            fallback["log"] = (f"Partial compilation failed:\n{partial_log}\n\n"
                               f"Full compilation fallback also failed:\n{fallback.get('log') or ''}")
        return fallback

    result = await asyncio.to_thread(run)
    result["compiled_main_file"] = main_file
    compiler_debug = result.get("compiler_debug", {}) or {}
    debug.update(result_success=result.get("success"), pdf_path=result.get("pdf_path", ""),
                 synctex_path=result.get("synctex_path", ""), compiler_debug=compiler_debug,
                 compiler_cwd=compiler_debug.get("cwd", ""), compiler_input_tex=compiler_debug.get("input_tex", ""),
                 compiler_returncode=compiler_debug.get("returncode", ""), timing=result.get("timing") or {},
                 partial_mode=result.get("partial_mode", debug.get("partial_mode", "")))
    debug_file = _write_compile_debug(project_path, debug)
    if debug_file:
        debug["debug_file"] = debug_file
        _write_compile_debug(project_path, debug)
    result["compile_debug"] = debug
    if not result.get("success"):
        result["log"] = (f"{_format_compile_debug(debug)}\n\nCompilation target: {main_file or '(unresolved)'}\n\n"
                         f"{result.get('log') or ''}")
    app[STATE_KEY].remember(result)
    if result.get("success") and result.get("pdf_path"):
        result["pdf_url"] = f"/api/latex/pdf?ts={int(time.time() * 1000)}"
    timing = result.get("timing") or {}
    timing["request_seconds"] = round(time.perf_counter() - started, 3)
    result["timing"] = timing
    return result


@routes.get("/api/latex/pdf-source")
async def pdf_source(request: web.Request) -> web.Response:
    """The ``.tex`` a standalone PDF is compiled from, if the project has one."""
    from gilzacode.latex_compiler import find_pdf_source_tex
    project_path, pdf_path = request.query.get("projectPath", ""), request.query.get("pdfPath", "")
    if not project_path or not pdf_path:
        return error(400, "projectPath and pdfPath are required")
    return web.json_response({"texFile": find_pdf_source_tex(project_path, pdf_path)})


@routes.post("/api/latex/compile-pdf-source")
async def compile_pdf_source(request: web.Request) -> web.Response:
    """Recompile a standalone PDF from its ``.tex`` on disk (not open in the editor)."""
    from gilzacode.latex_compiler import compile_latex, find_pdf_source_tex
    started = time.perf_counter()
    data = await read_json(request)
    project_path = str(data.get("projectPath", "") or "").strip()
    pdf_path = str(data.get("pdfPath", "") or "").strip()
    draft = bool(data.get("draft", False))
    synctex = (not draft) or _synctex_in_draft()
    if not project_path or not os.path.isdir(project_path) or not pdf_path:
        return web.json_response({"success": False,
                                  "log": "compile-pdf-source requires a valid projectPath and pdfPath."}, status=400)
    tex_file = find_pdf_source_tex(project_path, pdf_path)
    if not tex_file:
        return web.json_response({
            "success": False, "compiled_main_file": "",
            "log": f"No root LaTeX document compiles to {pdf_path}: expected a .tex file with the same name "
                   "in the same folder."})
    abs_tex = os.path.abspath(os.path.join(project_path, tex_file))
    try:
        with open(abs_tex, "r", encoding="utf-8", errors="ignore", newline="") as handle:
            content = handle.read()
    except OSError as exc:
        return web.json_response({"success": False, "log": f"Could not read {tex_file}: {exc}",
                                  "compiled_main_file": tex_file})
    result = await asyncio.to_thread(compile_latex, content, abs_tex, tex_file, project_path,
                                     include_pdf_base64=False, draft=draft, synctex=synctex)
    result["compiled_main_file"] = tex_file
    if not result.get("success"):
        result["source_content"] = content
    else:
        _state(request).remember(result)
    timing = result.get("timing") or {}
    timing["request_seconds"] = round(time.perf_counter() - started, 3)
    result["timing"] = timing
    return web.json_response(result)


@routes.get("/api/latex/render-include")
async def render_include(request: web.Request) -> web.Response:
    """An ``\\includegraphics`` file as an inline PNG/SVG for the Rich Text editor."""
    from gilzacode.latex_compiler import render_include_to_png
    query = request.query
    project_path, file_path = query.get("projectPath", ""), query.get("filePath", "")
    if not project_path or not file_path:
        return web.json_response({"success": False, "error": "projectPath and filePath are required"}, status=400)
    try:
        result = await asyncio.to_thread(render_include_to_png, project_path=project_path, file_path=file_path,
                                         source_tex=query.get("sourceTex", "") or "",
                                         output=(query.get("output", "auto") or "auto").lower())
    except Exception as exc:  # the renderer raises PyMuPDF and image errors of every kind
        return web.json_response({"success": False, "error": f"Render include failed: {exc}"}, status=500)
    if not result.get("success"):
        return web.json_response(result)
    return web.json_response({"success": True, "mime": result["mime"],
                              "data_base64": base64.b64encode(result["data"]).decode("ascii")})


@routes.post("/api/latex/render-graphic")
async def render_graphic(request: web.Request) -> web.Response:
    """A single TikZ/pgfplots/chemfig/... graphic rendered to SVG."""
    from gilzacode.latex_compiler import render_graphic_to_svg
    data = await read_json(request)
    graphic = data.get("graphic", "")
    if not graphic:
        return web.json_response({"success": False, "svg": "", "log": "graphic source is required"}, status=400)
    try:
        result = await asyncio.to_thread(
            render_graphic_to_svg, graphic_source=graphic, project_path=data.get("projectPath", "") or "",
            preamble=data.get("preamble", "") or "", cache_key=data.get("cacheKey", "") or "",
            graphic_engine=data.get("graphicEngine", "") or "", source_tex=data.get("sourceTex", "") or "")
    except Exception as exc:  # Tectonic and the SVG conversion fail in many ways
        return web.json_response({"success": False, "svg": "", "log": f"Render failed: {exc}"}, status=500)
    return web.json_response(result)


@routes.get("/api/latex/check-tectonic")
async def check_tectonic(_request: web.Request) -> web.Response:
    from gilzacode.latex_compiler import get_tectonic_path
    return web.json_response({"found": get_tectonic_path() is not None})


@routes.get("/api/latex/check-pandoc")
async def check_pandoc(_request: web.Request) -> web.Response:
    from gilzacode.document_exporter import get_pandoc_path
    return web.json_response({"found": get_pandoc_path() is not None})


@routes.post("/api/latex/export-docx")
async def export_docx(request: web.Request) -> web.Response:
    from gilzacode.document_exporter import export_tex_to_docx
    data = await read_json(request)
    project_path, file_path = data.get("projectPath", ""), data.get("filePath", "")
    content, output_path = data.get("content"), data.get("outputPath", "")
    if not project_path or not file_path:
        return web.json_response({"success": False, "error": "projectPath and filePath are required"}, status=400)
    try:
        if content is not None:
            full = os.path.abspath(file_path if os.path.isabs(file_path) else os.path.join(project_path, file_path))
            if not is_within(full, os.path.abspath(os.path.expanduser(project_path))):
                raise ValueError("filePath must stay inside the project directory")
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8", newline="") as handle:
                handle.write(content)
        result = await asyncio.to_thread(export_tex_to_docx, project_path, file_path, output_path)
    except Exception as exc:  # pandoc failures surface as assorted exceptions
        return web.json_response({"success": False, "output_path": "", "log": f"DOCX export failed: {exc}",
                                  "error": str(exc)}, status=500)
    return web.json_response(result)


@routes.get("/api/latex/pdf")
async def latest_pdf(request: web.Request) -> web.StreamResponse:
    state = _state(request)
    if not state.pdf_path or not os.path.exists(state.pdf_path):
        return web.Response(status=404, text="No PDF generated yet.")
    return web.FileResponse(state.pdf_path, headers={"Content-Type": "application/pdf"})


@routes.get("/api/latex/check-pdf")
async def check_pdf(request: web.Request) -> web.Response:
    """Whether the document behind ``filePath`` already has a compiled PDF; remembers it if so."""
    file_path, project_path = request.query.get("filePath", ""), request.query.get("projectPath", "")
    if file_path and os.path.isabs(file_path) and not project_path:
        project_path = os.path.dirname(file_path)
    if not file_path or not project_path:
        return error(400, "filePath and projectPath are required")
    full = os.path.abspath(os.path.join(project_path, file_path))
    try:
        with open(full, "r", encoding="utf-8", errors="ignore", newline="") as handle:
            content = handle.read()
    except OSError:
        content = ""
    main_file = _resolve_main_file(project_path, full, content, _registered_main_file(project_path))
    base = os.path.abspath(os.path.join(project_path, main_file)) if main_file else full
    target_pdf = os.path.splitext(base)[0] + ".pdf"
    if not os.path.exists(target_pdf):
        return web.json_response({"found": False})
    state = _state(request)
    state.pdf_path, state.synctex_path = target_pdf, os.path.splitext(base)[0] + ".synctex.gz"
    return web.json_response({"found": True, "pdf_url": f"/api/latex/pdf?ts={int(time.time() * 1000)}"})


def _source_result(result: dict | None, base_dir: str, project_path: str) -> tuple[dict | None, str]:
    """Make a pdf2tex record's file absolute and project-relative; '' or an error message."""
    if not result or "file" not in result:
        return result, ""
    abs_file = result["file"]
    if not os.path.isabs(abs_file):
        abs_file = os.path.abspath(os.path.join(base_dir, abs_file))
    if not os.path.isfile(abs_file):
        return None, f"synctex source file not found: {abs_file}"
    result["file"] = abs_file
    result["relFile"] = _relpath(abs_file, project_path)
    return result, ""


@routes.get("/api/latex/synctex")
async def synctex(request: web.Request) -> web.Response:
    """Forward (``tex2pdf``) and inverse (``pdf2tex``) search."""
    from gilzacode.synctex_parser import GeneratedSourceError, companion_synctex_path, find_pdf_position, find_source_line
    query = request.query
    action, file_path, project_path = query.get("action", ""), query.get("filePath", ""), query.get("projectPath", "")
    if file_path and os.path.isabs(file_path) and not project_path:
        project_path = os.path.dirname(file_path)
    if not file_path or not project_path or not action:
        return error(400, "action, filePath and projectPath are required")
    try:
        if file_path.lower().endswith(".pdf"):
            # A standalone PDF is linked to its source only through its own SyncTeX
            # file; the project's main file would map the click through another document.
            if action != "pdf2tex":
                return error(400, "only pdf2tex is supported for a PDF file")
            synctex_path = companion_synctex_path(os.path.abspath(os.path.join(project_path, file_path)))
            if not synctex_path:
                return error(404, "synctex file not found")
            found = find_source_line(synctex_path, int(query.get("page", "1")),
                                     float(query.get("x", "0")), float(query.get("y", "0")))
            result, problem = _source_result(found, os.path.dirname(synctex_path), project_path)
            return error(404, problem) if problem else web.json_response({"result": result})

        target = os.path.abspath(os.path.join(project_path, file_path))
        try:
            with open(target, "r", encoding="utf-8", errors="ignore", newline="") as handle:
                content = handle.read()
        except OSError:
            content = ""
        main_file = _resolve_main_file(project_path, target, content, _registered_main_file(project_path))
        main_full = os.path.abspath(os.path.join(project_path, main_file)) if main_file else target
        synctex_path = os.path.splitext(main_full)[0] + ".synctex.gz"
        state = _state(request)
        if state.synctex_path and os.path.exists(state.synctex_path):
            synctex_path = state.synctex_path
        if not os.path.exists(synctex_path):
            return error(404, "synctex file not found")
        if action == "pdf2tex":
            found = find_source_line(synctex_path, int(query.get("page", "1")),
                                     float(query.get("x", "0")), float(query.get("y", "0")))
            result, problem = _source_result(found, project_path, project_path)
            return error(404, problem) if problem else web.json_response({"result": result})
        if action == "tex2pdf":
            return web.json_response({"result": find_pdf_position(synctex_path, target, int(query.get("line", "1")))})
        return error(400, "invalid action")
    except GeneratedSourceError as exc:
        return error(404, str(exc))
    except ValueError as exc:
        return error(400, str(exc))


@routes.post("/api/latex/clean")
async def clean(request: web.Request) -> web.Response:
    from gilzacode.latex_compiler import clean_latex_artifacts
    data = await read_json(request)
    project_path = data.get("projectPath", "")
    if not project_path:
        return error(400, "projectPath is required")
    try:
        result = await asyncio.to_thread(clean_latex_artifacts, project_path)
    except Exception as exc:  # file removal errors per artifact
        return web.json_response({"success": False, "removed": [], "errors": [str(exc)]}, status=500)
    if result.get("success"):
        _state(request).pdf_path = ""
    return web.json_response(result, status=200 if result.get("success") else 500)


@routes.get("/api/settings/latex")
async def get_latex_settings(_request: web.Request) -> web.Response:
    return web.json_response({"draft_synctex_enabled": _synctex_in_draft()})


@routes.post("/api/settings/latex")
async def set_latex_settings(request: web.Request) -> web.Response:
    data = await read_json(request)
    enabled = bool(data.get("draft_synctex_enabled", False))
    settings.save({"draft_synctex_enabled": enabled})
    return web.json_response({"success": True, "draft_synctex_enabled": enabled})


def _download(url: str, filename: str, install) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        archive = os.path.join(tmp, filename)
        urllib.request.urlretrieve(url, archive)
        return install(archive)


@routes.post("/api/settings/install-tectonic")
async def install_tectonic(_request: web.Request) -> web.Response:
    """Download Tectonic into ``<gilzacode home>/bin``."""
    from gilzacode.external_tools import executable_name, install_executable_from_archive
    if sys.platform != "win32":
        return error(400, "Installing Tectonic is implemented for Windows only.")
    try:
        path = await asyncio.to_thread(_download, TECTONIC_URL_WINDOWS, "tectonic.zip",
                                       lambda a: install_executable_from_archive(a, executable_name("tectonic")))
    except Exception as exc:  # network and archive errors
        return error(500, str(exc))
    return web.json_response({"success": True, "path": path})


@routes.post("/api/settings/install-pandoc")
async def install_pandoc(_request: web.Request) -> web.Response:
    """Download pandoc into ``<gilzacode home>/bin``."""
    from gilzacode.document_exporter import get_pandoc_download, install_pandoc_from_archive
    try:
        url, filename = get_pandoc_download()
        path = await asyncio.to_thread(_download, url, filename, install_pandoc_from_archive)
    except Exception as exc:  # network and archive errors
        return error(500, str(exc))
    return web.json_response({"success": True, "path": path})
