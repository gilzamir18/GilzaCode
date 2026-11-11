"""The `claude` CLI: locating it, its environment, and one-off headless calls.

GilzaCode makes no model API calls of its own. One-off tasks (Translate, Look up)
run ``claude -p`` (PROJECT_DESIGN.md §2):

* the prompt goes through stdin, because an excerpt can be 20 000 characters and
  the Windows command line is limited to 32 767;
* ``--strict-mcp-config``, ``--no-session-persistence`` and ``--setting-sources ""``
  keep the call independent of the user's MCP servers, history and settings;
* ``--tools`` names exactly the built-in tools the task may use ("" for none);
* ``--output-format stream-json`` reports each tool call, which is how Look up
  knows which files it read.

``--bare`` is not used: it accepts only ``ANTHROPIC_API_KEY``, not a claude.ai login.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from dataclasses import dataclass, field

#: Markers a Claude Code session sets for the processes it starts. GilzaCode's
#: own Claude sessions are not children of whatever session launched GilzaCode
#: (during development, a Claude Code terminal), so the markers are not passed on.
NESTED_SESSION_MARKERS = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION")

INSTALL_HINT = "Install Claude Code (https://code.claude.com) and make sure `claude` is on PATH, then try again."


class ClaudeCliError(RuntimeError):
    """A headless call failed; the message is for the user. ``kind`` classifies it."""

    def __init__(self, message: str, kind: str = "failed"):
        super().__init__(message)
        self.kind = kind


def installer_locations() -> list[str]:
    """Where Claude Code's own installer puts `claude`, searched after PATH.

    Linux only. A program started from the desktop menu gets the login
    session's PATH, not the shell's: the native installer's ``~/.local/bin`` is
    missing from it until the next login (Ubuntu's ``~/.profile`` adds it only
    when the folder existed at login), so `claude` works in a terminal while the
    window cannot find it. Windows: none (the installer puts it on PATH).
    """
    import sys

    if not sys.platform.startswith("linux"):
        return []
    return [os.path.join(os.path.expanduser("~"), ".local", "bin", "claude")]


def find_claude() -> str:
    """The `claude` executable, or `ClaudeCliError` (kind ``not_installed``)."""
    configured = os.environ.get("GILZACODE_CLAUDE", "").strip()
    found = configured if configured and os.path.isfile(configured) else shutil.which("claude")
    if not found:
        found = next((path for path in installer_locations() if os.path.isfile(path) and os.access(path, os.X_OK)),
                     None)
    if not found:
        raise ClaudeCliError(f"Claude Code (`claude`) was not found. {INSTALL_HINT}", kind="not_installed")
    return found


def child_environment(base: dict | None = None) -> dict:
    from gilzacode.subprocess_utils import host_environment

    env = host_environment(base)
    for name in NESTED_SESSION_MARKERS:
        env.pop(name, None)
    return env


@dataclass
class HeadlessResult:
    text: str
    files_read: list[str] = field(default_factory=list)


def headless_argv(executable: str, *, system_prompt: str, model: str, tools: tuple[str, ...]) -> list[str]:
    return [
        executable, "-p",
        "--model", model,
        "--system-prompt", system_prompt,
        "--tools", ",".join(tools),
        *(["--allowedTools", ",".join(tools)] if tools else []),
        "--strict-mcp-config",
        "--no-session-persistence",
        "--setting-sources", "",
        "--output-format", "stream-json",
        "--verbose",
    ]


def parse_stream(stdout: str) -> HeadlessResult:
    """The final answer and the files the Read tool opened, from ``stream-json`` lines."""
    files: list[str] = []
    result = None
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "assistant":
            for block in (event.get("message") or {}).get("content") or []:
                if block.get("type") == "tool_use" and block.get("name") == "Read":
                    path = str((block.get("input") or {}).get("file_path") or "")
                    if path and path not in files:
                        files.append(path)
        elif event.get("type") == "result":
            result = event
    if result is None:
        raise ClaudeCliError("Claude Code ended without a result.", kind="failed")
    if result.get("is_error"):
        detail = str(result.get("result") or result.get("subtype") or "unknown error")
        raise ClaudeCliError(f"Claude Code reported an error: {detail}", kind="failed")
    return HeadlessResult(text=str(result.get("result") or ""), files_read=files)


async def run_headless(prompt: str, *, system_prompt: str, model: str, tools: tuple[str, ...] = (),
                       cwd: str | None = None, timeout: float = 180.0) -> HeadlessResult:
    """Run one ``claude -p`` call and return its answer. Raises `ClaudeCliError`."""
    argv = headless_argv(find_claude(), system_prompt=system_prompt, model=model, tools=tools)
    process = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, env=child_environment(),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(process.communicate(prompt.encode("utf-8")), timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise ClaudeCliError(f"Claude Code did not answer within {int(timeout)} seconds.", kind="timeout") from None
    stdout = out.decode("utf-8", "replace")
    if process.returncode != 0 and '"type":"result"' not in stdout.replace(" ", ""):
        detail = err.decode("utf-8", "replace").strip() or stdout.strip() or f"exit status {process.returncode}"
        raise ClaudeCliError(f"Claude Code failed: {detail[-800:]}", kind="failed")
    return parse_stream(stdout)


# ── The panel's interactive session ─────────────────────────────────────────

#: MCP tools that only read the window or change what it shows; Claude Code may
#: use them without asking. compile_latex writes files, so it asks.
PRE_ALLOWED_TOOLS = ("get_editor_state", "get_pdf_view", "get_problems", "list_pdf_annotations",
                     "open_file", "close_file", "reveal_in_pdf", "set_layout")


def bridge_command() -> tuple[str, list[str]]:
    """How to start the bridge: the bundled ``gilzacode-mcp`` (``.exe`` on
    Windows) in a packaged build (a console executable next to the window's),
    else ``python -m``."""
    import sys

    from gilzacode.external_tools import executable_name

    if getattr(sys, "frozen", False):
        exe = os.path.join(os.path.dirname(sys.executable), executable_name("gilzacode-mcp"))
        if not os.path.isfile(exe):
            raise ClaudeCliError(f"The GilzaCode MCP bridge is missing from the installation ({exe}). "
                                 "Reinstall GilzaCode.", kind="not_installed")
        return exe, []
    return sys.executable, ["-m", "gilzacode.mcp_bridge"]


def write_mcp_config() -> str:
    """Write ``<gilzacode home>/mcp-config.json`` naming the GilzaCode bridge; return its path."""
    from gilzacode.paths import gilzacode_home, write_text_atomic
    command, args = bridge_command()
    path = gilzacode_home() / "mcp-config.json"
    write_text_atomic(path, json.dumps({"mcpServers": {"gilzacode": {"command": command, "args": args}}}, indent=2))
    return str(path)


def claude_session_argv() -> list[str]:
    """`claude` with the GilzaCode bridge added to the user's own MCP servers."""
    return [find_claude(), "--mcp-config", write_mcp_config(),
            "--allowedTools", ",".join(f"mcp__gilzacode__{name}" for name in PRE_ALLOWED_TOOLS)]


def claude_session_env(project_path: str) -> dict:
    from gilzacode.external_tools import environment_with_managed_tools
    env = environment_with_managed_tools(child_environment())
    env["GILZACODE_PROJECT"] = project_path
    return env
