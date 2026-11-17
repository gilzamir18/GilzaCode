"""The GilzaCode skills: a Claude Code plugin installed through the `claude` CLI.

The skills live in their own repository, ``gilzamir18/GilzaCodeSkills``, which is
both a Claude Code marketplace (``gilzacode``) and the one plugin it lists
(``gilzacode-skills``). GilzaCode does not copy skill files into
``~/.claude`` itself: it runs Claude Code's own plugin commands, so the plugin is
installed, updated and removed exactly as one installed with ``/plugin``
(PROJECT_DESIGN.md §8, *GilzaCode skills*).

* ``claude plugin list --json`` says whether it is installed, and in which scopes;
* ``claude plugin install gilzacode-skills --marketplace <repo> --scope <scope> --json``
  adds the marketplace to the user's settings when it is missing and installs
  the plugin for the user (``user``: every project) or only for the open
  project and this user (``local``, run in the project folder);
* ``claude plugin uninstall gilzacode-skills@gilzacode --scope <scope> --json``
  removes it from one scope;
* ``claude plugin marketplace update gilzacode`` followed by
  ``claude plugin update gilzacode-skills@gilzacode --scope <scope>`` brings each
  install up to date.

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


#: Where the plugin can be installed: for the user (every project), or only for
#: one project and only for this user (``<project>/.claude/settings.local.json``,
#: which Claude Code adds to the user's global Git ignore). Claude Code's third
#: scope, ``project`` (committed ``.claude/settings.json``), is not offered.
SCOPES = ("user", "local")


def _project(project_path: str) -> str:
    project = os.path.abspath(str(project_path or "").strip() or ".")
    if not str(project_path or "").strip() or not os.path.isdir(project):
        raise ValueError("Open a project to install the skills only for it.")
    return project


def _scope(scope: str) -> str:
    if scope not in SCOPES:
        raise ValueError(f"The scope must be one of {', '.join(SCOPES)}.")
    return scope


async def _run(args: tuple[str, ...], timeout: float, cwd: str | None = None) -> tuple[int, str, str]:
    argv = plugin_argv(find_claude(), *args)
    # The home folder for the user scope; the project for the local scope, which
    # Claude Code ties to its working directory.
    process = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd or os.path.expanduser("~"), env=child_environment(),
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


async def _command(*args: str, timeout: float = NETWORK_TIMEOUT, cwd: str | None = None) -> dict:
    """Run a ``--json`` plugin command; its result, or `ClaudeCliError` when it failed."""
    code, stdout, stderr = await _run(args, timeout, cwd)
    result = _result_line(stdout)
    if result is None:
        detail = stderr.strip() or stdout.strip() or f"exit status {code}"
        raise ClaudeCliError(f"`claude plugin {args[0]}` gave no result: {detail[-800:]}", kind="failed")
    if result.get("outcome") != "ok" or code != 0:
        message = str(result.get("message") or stderr.strip() or f"exit status {code}")
        raise ClaudeCliError(message[-1500:], kind="failed")
    return result


def _same_path(a: str, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _entry(plugins: list, scope: str, project: str | None) -> dict | None:
    """The plugin's entry for `scope`. Local entries are listed from any folder,
    each with its ``projectPath``, so only the open project's one counts."""
    for plugin in plugins:
        if not isinstance(plugin, dict) or plugin.get("id") != PLUGIN_ID or plugin.get("scope") != scope:
            continue
        if scope == "local" and not (project and _same_path(str(plugin.get("projectPath") or ""), project)):
            continue
        return plugin
    return None


def _describe(entry: dict | None) -> dict:
    return {"installed": entry is not None, "enabled": bool(entry and entry.get("enabled")),
            "version": str(entry.get("version") or "") if entry else ""}


async def skills_status(project_path: str = "") -> dict:
    """Whether the skills are installed for the user and for the open project (``local`` is None without one)."""
    project = _project(project_path) if str(project_path or "").strip() else None
    code, stdout, stderr = await _run(("list", "--json"), LIST_TIMEOUT, project)
    try:
        plugins = json.loads(stdout)
    except ValueError:
        plugins = None
    if code != 0 or not isinstance(plugins, list):
        detail = stderr.strip() or stdout.strip() or f"exit status {code}"
        raise ClaudeCliError(f"`claude plugin list` failed: {detail[-800:]}", kind="failed")
    return {
        "plugin": PLUGIN_ID,
        "repository": REPOSITORY_URL,
        "project": project or "",
        "scopes": {
            "user": _describe(_entry(plugins, "user", project)),
            "local": _describe(_entry(plugins, "local", project)) if project else None,
        },
    }


def _cwd(scope: str, project_path: str) -> str | None:
    return _project(project_path) if scope == "local" else None


async def install_skills(scope: str = "user", project_path: str = "") -> dict:
    """Install the plugin in `scope`, adding its marketplace first when needed."""
    cwd = _cwd(_scope(scope), project_path)
    await _command("install", PLUGIN_NAME, "--marketplace", MARKETPLACE_SOURCE, "--scope", scope, "--json", cwd=cwd)
    return await skills_status(project_path)


async def uninstall_skills(scope: str = "user", project_path: str = "") -> dict:
    """Remove the plugin from `scope` only; another scope's install stays."""
    cwd = _cwd(_scope(scope), project_path)
    await _command("uninstall", PLUGIN_ID, "--scope", scope, "--json", timeout=LIST_TIMEOUT, cwd=cwd)
    return await skills_status(project_path)


async def update_skills(project_path: str = "") -> dict:
    """Refresh the marketplace, then update the plugin in each scope it is installed in.

    The result carries ``updated``: false when every install was already current.
    """
    status = await skills_status(project_path)
    installed = [scope for scope, state in status["scopes"].items() if state and state["installed"]]
    if not installed:
        raise ValueError("The skills are not installed.")
    await _command("marketplace", "update", MARKETPLACE_NAME, "--json")
    updated = False
    for scope in installed:
        result = await _command("update", PLUGIN_ID, "--scope", scope, "--json", cwd=_cwd(scope, project_path))
        updated = updated or result.get("updateOutcome") != "up_to_date"
    status = await skills_status(project_path)
    status["updated"] = updated
    return status
