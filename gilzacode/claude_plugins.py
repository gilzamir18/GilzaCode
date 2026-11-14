"""The GilzaCode skills: a Claude Code plugin installed through the `claude` CLI.

The skills live in their own repository, ``gilzamir18/GilzaCodeSkills``, which is
both a Claude Code marketplace (``gilzacode``) and the one plugin it lists
(``gilzacode-skills``). GilzaCode does not copy skill files into
``~/.claude`` itself: it runs Claude Code's own plugin commands, so the plugin is
installed, updated and removed exactly as one installed with ``/plugin``
(PROJECT_DESIGN.md §8, *GilzaCode skills*).

* ``claude plugin list --json`` says whether it is installed;
* ``claude plugin install gilzacode-skills --marketplace <repo> --json`` adds the
  marketplace to the user's settings when it is missing and installs the plugin
  at user scope, so it serves every project;
* ``claude plugin marketplace update gilzacode`` followed by
  ``claude plugin update gilzacode-skills@gilzacode`` brings it up to date.

Each ``--json`` command prints one result line with ``outcome`` ``ok`` or
``failed``; a failure is raised as `ClaudeCliError` with the CLI's own message.
``-y`` is never passed: it would accept a command the marketplace declares
without showing it to anyone, and this marketplace declares none.
"""

from __future__ import annotations

import asyncio
import json
import os

from gilzacode.claude_cli import ClaudeCliError, child_environment, find_claude

MARKETPLACE_SOURCE = "gilzamir18/GilzaCodeSkills"
MARKETPLACE_NAME = "gilzacode"
PLUGIN_NAME = "gilzacode-skills"
PLUGIN_ID = f"{PLUGIN_NAME}@{MARKETPLACE_NAME}"
REPOSITORY_URL = f"https://github.com/{MARKETPLACE_SOURCE}"

#: An install or update clones or fetches the repository.
NETWORK_TIMEOUT = 180.0
LIST_TIMEOUT = 60.0


def plugin_argv(executable: str, *args: str) -> list[str]:
    return [executable, "plugin", *args]


async def _run(args: tuple[str, ...], timeout: float) -> tuple[int, str, str]:
    argv = plugin_argv(find_claude(), *args)
    # The home folder, not a project: `plugin list` reports project scopes for
    # its working directory, and the plugin is installed for the user.
    process = await asyncio.create_subprocess_exec(
        *argv, cwd=os.path.expanduser("~"), env=child_environment(),
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise ClaudeCliError(f"Claude Code did not finish `claude plugin {args[0]}` within {int(timeout)} seconds.",
                             kind="timeout") from None
    return process.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _result_line(stdout: str) -> dict | None:
    """The last JSON object line on stdout (`--json` prints its result last)."""
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    return None


async def _command(*args: str, timeout: float = NETWORK_TIMEOUT) -> dict:
    """Run a ``--json`` plugin command; its result, or `ClaudeCliError` when it failed."""
    code, stdout, stderr = await _run(args, timeout)
    result = _result_line(stdout)
    if result is None:
        detail = stderr.strip() or stdout.strip() or f"exit status {code}"
        raise ClaudeCliError(f"`claude plugin {args[0]}` gave no result: {detail[-800:]}", kind="failed")
    if result.get("outcome") != "ok" or code != 0:
        message = str(result.get("message") or stderr.strip() or f"exit status {code}")
        raise ClaudeCliError(message[-1500:], kind="failed")
    return result


async def skills_status() -> dict:
    """Whether the GilzaCode skills plugin is installed, and which version."""
    code, stdout, stderr = await _run(("list", "--json"), LIST_TIMEOUT)
    try:
        plugins = json.loads(stdout)
    except ValueError:
        plugins = None
    if code != 0 or not isinstance(plugins, list):
        detail = stderr.strip() or stdout.strip() or f"exit status {code}"
        raise ClaudeCliError(f"`claude plugin list` failed: {detail[-800:]}", kind="failed")
    entry = next((p for p in plugins if isinstance(p, dict) and p.get("id") == PLUGIN_ID), None)
    return {
        "plugin": PLUGIN_ID,
        "repository": REPOSITORY_URL,
        "installed": entry is not None,
        "enabled": bool(entry and entry.get("enabled")),
        "version": str(entry.get("version") or "") if entry else "",
    }


async def install_skills() -> dict:
    """Install the plugin at user scope, adding its marketplace first when needed."""
    await _command("install", PLUGIN_NAME, "--marketplace", MARKETPLACE_SOURCE, "--scope", "user", "--json")
    return await skills_status()


async def update_skills() -> dict:
    """Refresh the marketplace, then update the plugin to the version it lists.

    The result carries ``updated``: false when the plugin was already current.
    """
    await _command("marketplace", "update", MARKETPLACE_NAME, "--json")
    result = await _command("update", PLUGIN_ID, "--json")
    status = await skills_status()
    status["updated"] = result.get("updateOutcome") != "up_to_date"
    return status
