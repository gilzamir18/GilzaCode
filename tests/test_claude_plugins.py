"""The GilzaCode skills plugin: installed, removed, updated and reported through `claude plugin`, per scope."""

import json
import os
import sys

import pytest

from gilzacode import claude_plugins

FAKE = r'''
import json, os, sys
args = sys.argv[1:]
base = sys.argv[0]
with open(base + ".calls", "a", encoding="utf-8") as log:
    log.write(json.dumps({"args": args, "cwd": os.getcwd()}) + "\n")
replies = json.load(open(base + ".replies", encoding="utf-8"))
reply = replies.get(" ".join(args[:3]), replies.get(" ".join(args[:2]), {"stdout": "", "code": 9}))
if reply.get("stderr"):
    sys.stderr.write(reply["stderr"])
sys.stdout.write(reply["stdout"])
sys.exit(reply.get("code", 0))
'''

USER = {"id": "gilzacode-skills@gilzacode", "version": "0.1.0", "scope": "user", "enabled": True}
OTHER = [{"id": "something@else", "version": "2.0.0", "scope": "user", "enabled": True}]


def local(project, version="0.1.0"):
    return {"id": "gilzacode-skills@gilzacode", "version": version, "scope": "local", "enabled": True,
            "projectPath": str(project)}


def listed(*plugins):
    return {"stdout": json.dumps(list(plugins)), "code": 0}


def ok(**extra):
    return {"stdout": json.dumps({"outcome": "ok", **extra}) + "\n", "code": 0}


def same(a, b):
    return os.path.normcase(os.path.abspath(str(a))) == os.path.normcase(os.path.abspath(str(b)))


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    """A `claude` stand-in: replies are keyed by the first words after `plugin`."""
    script = tmp_path / "fake_claude.py"
    script.write_text(FAKE, encoding="utf-8")
    monkeypatch.setattr(claude_plugins, "find_claude", lambda: sys.executable)
    monkeypatch.setattr(claude_plugins, "plugin_argv",
                        lambda exe, *args: [sys.executable, str(script), "plugin", *args])

    def configure(replies):
        (tmp_path / "fake_claude.py.replies").write_text(json.dumps(replies), encoding="utf-8")

    def records():
        path = tmp_path / "fake_claude.py.calls"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    configure.calls = lambda: [record["args"] for record in records()]
    configure.cwds = lambda: [record["cwd"] for record in records()]
    configure({"plugin list": listed()})
    return configure


def test_the_plugin_is_named_after_its_marketplace():
    assert claude_plugins.PLUGIN_ID == "gilzacode-skills@gilzacode"
    assert claude_plugins.plugin_argv("claude", "list", "--json") == ["claude", "plugin", "list", "--json"]


async def test_status_reads_the_installed_plugins(client, fake_cli):
    fake_cli({"plugin list": listed(*OTHER)})
    data = await (await client.get("/api/claude/skills")).json()
    assert data == {"plugin": "gilzacode-skills@gilzacode", "repository": "https://github.com/gilzamir18/GilzaCodeSkills",
                    "project": "", "scopes": {"user": {"installed": False, "enabled": False, "version": ""},
                                              "local": None}}
    fake_cli({"plugin list": listed(*OTHER, USER)})
    data = await (await client.get("/api/claude/skills")).json()
    assert data["scopes"]["user"] == {"installed": True, "enabled": True, "version": "0.1.0"}
    assert fake_cli.calls()[-1] == ["plugin", "list", "--json"]
    assert same(fake_cli.cwds()[-1], os.path.expanduser("~"))


async def test_a_local_install_counts_only_for_its_own_project(client, fake_cli, tmp_path):
    here, elsewhere = tmp_path / "here", tmp_path / "elsewhere"
    here.mkdir()
    elsewhere.mkdir()
    # Claude Code lists local installs from any folder, each with its project.
    fake_cli({"plugin list": listed(local(elsewhere))})
    data = await (await client.get("/api/claude/skills", params={"projectPath": str(here)})).json()
    assert data["scopes"]["local"]["installed"] is False and data["scopes"]["user"]["installed"] is False
    fake_cli({"plugin list": listed(local(here, "0.2.0"))})
    data = await (await client.get("/api/claude/skills", params={"projectPath": str(here)})).json()
    assert data["scopes"]["local"] == {"installed": True, "enabled": True, "version": "0.2.0"}
    assert same(fake_cli.cwds()[-1], here)


async def test_install_names_the_marketplace_and_the_scope(client, fake_cli):
    fake_cli({"plugin install": ok(), "plugin list": listed(USER)})
    response = await client.post("/api/claude/skills/install", json={"scope": "user"})
    assert response.status == 200
    assert (await response.json())["scopes"]["user"]["installed"]
    install = fake_cli.calls()[0]
    assert install == ["plugin", "install", "gilzacode-skills", "--marketplace", "gilzamir18/GilzaCodeSkills",
                       "--scope", "user", "--json"]
    assert "-y" not in install and "--yes" not in install  # nothing is accepted on the user's behalf
    assert same(fake_cli.cwds()[0], os.path.expanduser("~"))


async def test_a_local_install_runs_in_the_project(client, fake_cli, tmp_path):
    fake_cli({"plugin install": ok(), "plugin list": listed(local(tmp_path))})
    data = await (await client.post("/api/claude/skills/install",
                                    json={"scope": "local", "projectPath": str(tmp_path)})).json()
    assert data["scopes"]["local"]["installed"] and not data["scopes"]["user"]["installed"]
    assert fake_cli.calls()[0][-3:] == ["--scope", "local", "--json"]
    assert same(fake_cli.cwds()[0], tmp_path)


@pytest.mark.parametrize("body", [{"scope": "local"}, {"scope": "local", "projectPath": "Z:/missing/project"},
                                  {"scope": "project", "projectPath": "."}])
async def test_a_bad_scope_or_a_local_scope_without_a_project_is_refused(client, fake_cli, body):
    response = await client.post("/api/claude/skills/install", json=body)
    assert response.status == 400
    assert fake_cli.calls() == []


async def test_uninstall_removes_one_scope_only(client, fake_cli, tmp_path):
    fake_cli({"plugin uninstall": ok(), "plugin list": listed(USER)})
    data = await (await client.post("/api/claude/skills/uninstall",
                                    json={"scope": "local", "projectPath": str(tmp_path)})).json()
    assert fake_cli.calls()[0] == ["plugin", "uninstall", "gilzacode-skills@gilzacode", "--scope", "local", "--json"]
    assert same(fake_cli.cwds()[0], tmp_path)
    assert data["scopes"]["user"]["installed"] and not data["scopes"]["local"]["installed"]


async def test_a_failed_install_reports_the_cli_message(client, fake_cli):
    fake_cli({"plugin install": {"stdout": json.dumps({"outcome": "failed", "message": "Repository not found.",
                                                       "failureCode": "error_not_found"}) + "\n",
                                 "stderr": "Failed to add marketplace", "code": 1}})
    response = await client.post("/api/claude/skills/install", json={"scope": "user"})
    assert response.status == 502
    assert (await response.json())["error"] == "Repository not found."


async def test_a_command_without_a_result_is_an_error_not_a_success(client, fake_cli):
    fake_cli({"plugin install": {"stdout": "", "stderr": "unknown option --json", "code": 1}})
    response = await client.post("/api/claude/skills/install", json={"scope": "user"})
    assert response.status == 502
    assert "unknown option --json" in (await response.json())["error"]


async def test_update_refreshes_the_marketplace_then_each_installed_scope(client, fake_cli, tmp_path):
    fake_cli({"plugin marketplace update": ok(),
              "plugin update": ok(updateOutcome="updated", oldVersion="0.1.0", newVersion="0.2.0"),
              "plugin list": listed(USER, local(tmp_path))})
    data = await (await client.post("/api/claude/skills/update", json={"projectPath": str(tmp_path)})).json()
    assert data["updated"]
    calls, cwds = fake_cli.calls(), fake_cli.cwds()
    assert calls[1] == ["plugin", "marketplace", "update", "gilzacode", "--json"]
    updates = [(call, cwd) for call, cwd in zip(calls, cwds) if call[1] == "update"]
    assert [call for call, _ in updates] == [
        ["plugin", "update", "gilzacode-skills@gilzacode", "--scope", "user", "--json"],
        ["plugin", "update", "gilzacode-skills@gilzacode", "--scope", "local", "--json"]]
    assert same(updates[1][1], tmp_path)


async def test_an_update_that_found_nothing_new_says_so(client, fake_cli):
    fake_cli({"plugin marketplace update": ok(), "plugin update": ok(updateOutcome="up_to_date"),
              "plugin list": listed(USER)})
    data = await (await client.post("/api/claude/skills/update", json={})).json()
    assert data["updated"] is False and data["scopes"]["user"]["installed"]


async def test_updating_what_is_not_installed_is_refused(client, fake_cli):
    response = await client.post("/api/claude/skills/update", json={})
    assert response.status == 400


async def test_a_missing_claude_is_503(client, monkeypatch):
    def missing():
        raise claude_plugins.ClaudeCliError("Claude Code (`claude`) was not found.", kind="not_installed")

    monkeypatch.setattr(claude_plugins, "find_claude", missing)
    requests = (("/api/claude/skills", None), ("/api/claude/skills/install", {"scope": "user"}),
                ("/api/claude/skills/update", {}), ("/api/claude/skills/uninstall", {"scope": "user"}))
    for path, body in requests:
        response = await (client.get(path) if body is None else client.post(path, json=body))
        assert response.status == 503, path
        assert (await response.json())["kind"] == "not_installed"


@pytest.mark.skipif(os.environ.get("GILZACODE_LIVE_CLAUDE") != "1", reason="set GILZACODE_LIVE_CLAUDE=1 to call the real claude")
async def test_live_install_from_github(client, tmp_path, monkeypatch):
    # A throwaway Claude Code configuration, so the user's own is never touched.
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    project = tmp_path / "project"
    project.mkdir()
    query = {"projectPath": str(project)}
    status = await (await client.get("/api/claude/skills", params=query)).json()
    assert not status["scopes"]["user"]["installed"] and not status["scopes"]["local"]["installed"]
    data = await (await client.post("/api/claude/skills/install", json={"scope": "local", **query})).json()
    assert data["scopes"]["local"]["installed"] and not data["scopes"]["user"]["installed"]
    data = await (await client.post("/api/claude/skills/install", json={"scope": "user", **query})).json()
    assert data["scopes"]["user"]["installed"] and data["scopes"]["user"]["version"]
    data = await (await client.post("/api/claude/skills/update", json=query)).json()
    assert data["updated"] is False
    data = await (await client.post("/api/claude/skills/uninstall", json={"scope": "local", **query})).json()
    assert data["scopes"]["user"]["installed"] and not data["scopes"]["local"]["installed"]
