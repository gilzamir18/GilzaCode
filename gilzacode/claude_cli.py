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


def find_claude() -> str:
    """The `claude` executable, or `ClaudeCliError` (kind ``not_installed``)."""
    configured = os.environ.get("GILZACODE_CLAUDE", "").strip()
    found = configured if configured and os.path.isfile(configured) else shutil.which("claude")
    if not found:
        raise ClaudeCliError(f"Claude Code (`claude`) was not found. {INSTALL_HINT}", kind="not_installed")
    return found


def child_environment(base: dict | None = None) -> dict:
    env = dict(os.environ if base is None else base)
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
