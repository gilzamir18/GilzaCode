"""``gilzacode-mcp``: the MCP server Claude Code starts to reach the GilzaCode window.

Claude Code launches it over stdio (the panel passes ``--mcp-config``). It is a
thin bridge: each tool is one call to the running application's local API,
authenticated with the token in ``<gilzacode home>/connection.json``.

The JSON-RPC is written by hand, on purpose (PROJECT_DESIGN.md §2): Claude Code
first probes ``server/discover`` at protocol 2026-07-28 and falls back to
``initialize`` when the probe is refused. A server that accepted the probe would
land on the revision where channel notifications are not delivered, so this one
answers it "method not found" and negotiates a handshake revision.

The project is the folder Claude Code runs in (``GILZACODE_PROJECT``, set by the
panel, else the working directory). The window refuses commands for a project it
is not showing, and says so.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import urllib.error
import urllib.request
from urllib.parse import urlencode

from gilzacode import __version__

HANDSHAKE_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

INSTRUCTIONS = (
    "You are running inside GilzaCode, a desktop workspace for reading and writing (PDF, LaTeX, "
    "Markdown) whose window shows the user's editor tabs and a PDF pane next to this terminal. "
    "The gilzacode tools read and drive that window: what the user has open or selected "
    "(get_editor_state, get_pdf_view), showing them a file or a place in the PDF (open_file, "
    "reveal_in_pdf), compiling LaTeX so the PDF pane refreshes (compile_latex), the LaTeX errors "
    "the window shows (get_problems), and the annotations stored in a PDF (list_pdf_annotations). "
    "Paths are relative to the project folder. Edit files with your own tools; the editor reloads "
    "them from disk."
)

_STR = {"type": "string"}
_POS_INT = {"type": "integer", "minimum": 1}

TOOLS = [
    {"name": "get_editor_state",
     "description": "What the user has open in the GilzaCode editor: the project, open tabs, the focused file, "
                    "the cursor, the selected text with its line range, and which tabs have unsaved edits.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_pdf_view",
     "description": "What the PDF pane shows: the PDF document, the current page, the page count, and the text "
                    "the user selected in it most recently.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "open_file",
     "description": "Open a project file in the editor, optionally scrolled to a 1-based line. "
                    "focus=false adds a background tab instead of switching to it.",
     "inputSchema": {"type": "object", "properties": {"path": _STR, "line": _POS_INT, "focus": {"type": "boolean"}},
                     "required": ["path"]}},
    {"name": "close_file",
     "description": "Close an editor tab. Refused when the tab has unsaved edits.",
     "inputSchema": {"type": "object", "properties": {"path": _STR}, "required": ["path"]}},
    {"name": "reveal_in_pdf",
     "description": "Show the place in the compiled PDF that a line of a .tex file produced (SyncTeX forward "
                    "search), opening the file and the PDF pane.",
     "inputSchema": {"type": "object", "properties": {"path": _STR, "line": _POS_INT}, "required": ["path", "line"]}},
    {"name": "set_layout",
     "description": "Switch the window layout: 'ide' (editor, sidebar, panels), 'chat' (Claude Code across the "
                    "window, explorer on the left), 'studio' (editor and preview above, Claude Code and terminal "
                    "below), 'document' (the file and its preview only).",
     "inputSchema": {"type": "object", "properties": {"layout": {"type": "string", "enum": ["ide", "chat", "studio", "document"]}},
                     "required": ["layout"]}},
    {"name": "get_problems",
     "description": "The entries of the window's Problems panel (LaTeX compile errors).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "compile_latex",
     "description": "Compile a project .tex file as saved on disk with Tectonic (the project's main file is used "
                    "when the file belongs to one). The PDF pane refreshes, or shows the error. Returns success, "
                    "the compiled main file, the PDF path and the log.",
     "inputSchema": {"type": "object", "properties": {"path": _STR, "draft": {"type": "boolean"}}, "required": ["path"]}},
    {"name": "list_pdf_annotations",
     "description": "The annotations stored inside a project PDF (highlights, notes), with page, kind, text and author.",
     "inputSchema": {"type": "object", "properties": {"path": _STR}, "required": ["path"]}},
]

WINDOW_COMMANDS = {"get_editor_state", "get_pdf_view", "open_file", "close_file", "reveal_in_pdf", "set_layout",
                   "get_problems"}

_write_lock = threading.Lock()


class ToolError(Exception):
    """A tool failed; the message is returned to the model."""


def project_path() -> str:
    return os.path.abspath(os.environ.get("GILZACODE_PROJECT") or os.getcwd())


def connection() -> tuple[str, str]:
    from gilzacode.session import connection_file
    path = connection_file()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data["url"], data["token"]
    except (OSError, ValueError, KeyError):
        raise ToolError("GilzaCode is not running (no connection file). Ask the user to open GilzaCode.") from None


def call_app(method: str, path: str, *, body: dict | None = None, query: dict | None = None, timeout: float = 600) -> dict:
    url, token = connection()
    full = url + path + (f"?{urlencode(query)}" if query else "")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(full, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            message = json.loads(exc.read().decode("utf-8")).get("error")
        except ValueError:
            message = None
        raise ToolError(message or f"GilzaCode answered HTTP {exc.code}.") from None
    except (urllib.error.URLError, OSError) as exc:
        raise ToolError(f"GilzaCode could not be reached ({exc}). Ask the user whether it is still open.") from None


def run_tool(name: str, args: dict) -> dict:
    project = project_path()
    if name in WINDOW_COMMANDS:
        answer = call_app("POST", "/api/ide/command", body={"action": name, "args": args, "project_path": project})
        answer.pop("ok", None)
        answer.pop("id", None)
        return answer
    if name == "compile_latex":
        return call_app("POST", "/api/ide/compile",
                        body={"projectPath": project, "filePath": str(args.get("path") or ""),
                              "draft": bool(args.get("draft", False))})
    if name == "list_pdf_annotations":
        return call_app("GET", "/api/pdf/annotations", query={"projectPath": project, "filePath": str(args.get("path") or "")})
    raise ToolError(f"Unknown tool {name!r}.")


def send(message: dict) -> None:
    line = json.dumps(message, ensure_ascii=False)
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def handle_call(mid, name: str, args: dict) -> None:
    try:
        result = run_tool(name, args if isinstance(args, dict) else {})
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}]}})
    except ToolError as exc:
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": str(exc)}], "isError": True}})
    except Exception as exc:  # never leave Claude Code waiting on an id
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": f"gilzacode-mcp failed: {type(exc).__name__}: {exc}"}], "isError": True}})


def handle(message: dict) -> None:
    method, mid = message.get("method"), message.get("id")
    if method == "initialize":
        requested = (message.get("params") or {}).get("protocolVersion")
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": requested if requested in HANDSHAKE_VERSIONS else HANDSHAKE_VERSIONS[0],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "gilzacode", "version": __version__},
            "instructions": INSTRUCTIONS,
        }})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        params = message.get("params") or {}
        threading.Thread(target=handle_call, args=(mid, params.get("name"), params.get("arguments") or {}),
                         daemon=True).start()
    elif method == "ping" and mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif mid is not None:
        # Includes `server/discover`: refusing it keeps Claude Code on the handshake protocol.
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found"}})


def main() -> int:
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        if isinstance(message, dict):
            handle(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
