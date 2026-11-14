"""The GilzaCode skills plugin: installed, updated and reported through `claude plugin`."""

import json
import os
import sys

import pytest

from gilzacode import claude_plugins

FAKE = r'''
import json, sys
args = sys.argv[1:]
base = sys.argv[0]
with open(base + ".calls", "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\n")
replies = json.load(open(base + ".replies", encoding="utf-8"))
reply = replies.get(" ".join(args[:3]), replies.get(" ".join(args[:2]), {"stdout": "", "code": 9}))
if reply.get("stderr"):
    sys.stderr.write(reply["stderr"])
sys.stdout.write(reply["stdout"])
sys.exit(reply.get("code", 0))
'''

INSTALLED = [{"id": "gilzacode-skills@gilzacode", "version": "0.1.0", "scope": "user", "enabled": True}]
OTHER = [{"id": "something@else", "version": "2.0.0", "scope": "user", "enabled": True}]


def ok(**extra):
    return {"stdout": json.dumps({"outcome": "ok", **extra}) + "\n", "code": 0}


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

    def calls():
        path = tmp_path / "fake_claude.py.calls"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    configure.calls = calls
    configure({"plugin list": {"stdout": "[]", "code": 0}})
    return configure


def test_the_plugin_is_named_after_its_marketplace():
    assert claude_plugins.PLUGIN_ID == "gilzacode-skills@gilzacode"
    assert claude_plugins.plugin_argv("claude", "list", "--json") == ["claude", "plugin", "list", "--json"]


async def test_status_reads_the_installed_plugins(client, fake_cli):
    fake_cli({"plugin list": {"stdout": json.dumps(OTHER), "code": 0}})
    data = await (await client.get("/api/claude/skills")).json()
    assert data == {"plugin": "gilzacode-skills@gilzacode", "repository": "https://github.com/gilzamir18/GilzaCodeSkills",
                    "installed": False, "enabled": False, "version": ""}
    fake_cli({"plugin list": {"stdout": json.dumps(OTHER + INSTALLED), "code": 0}})
    data = await (await client.get("/api/claude/skills")).json()
    assert data["installed"] and data["enabled"] and data["version"] == "0.1.0"
    assert fake_cli.calls()[-1] == ["plugin", "list", "--json"]


async def test_install_names_the_marketplace_and_the_user_scope(client, fake_cli):
    replies = {"plugin install": ok(), "plugin list": {"stdout": json.dumps(INSTALLED), "code": 0}}
    fake_cli(replies)
    response = await client.post("/api/claude/skills/install")
    assert response.status == 200
    assert (await response.json())["installed"]
    install = fake_cli.calls()[0]
    assert install == ["plugin", "install", "gilzacode-skills", "--marketplace", "gilzamir18/GilzaCodeSkills",
                       "--scope", "user", "--json"]
    assert "-y" not in install and "--yes" not in install  # nothing is accepted on the user's behalf


async def test_a_failed_install_reports_the_cli_message(client, fake_cli):
    fake_cli({"plugin install": {"stdout": json.dumps({"outcome": "failed", "message": "Repository not found.",
                                                       "failureCode": "error_not_found"}) + "\n",
                                 "stderr": "✘ Failed to add marketplace", "code": 1}})
    response = await client.post("/api/claude/skills/install")
    assert response.status == 502
    assert (await response.json())["error"] == "Repository not found."


async def test_a_command_without_a_result_is_an_error_not_a_success(client, fake_cli):
    fake_cli({"plugin install": {"stdout": "", "stderr": "unknown option --json", "code": 1}})
    response = await client.post("/api/claude/skills/install")
    assert response.status == 502
    assert "unknown option --json" in (await response.json())["error"]


async def test_update_refreshes_the_marketplace_first(client, fake_cli):
    fake_cli({"plugin marketplace update": ok(),
              "plugin update": ok(updateOutcome="updated", oldVersion="0.1.0", newVersion="0.2.0"),
              "plugin list": {"stdout": json.dumps([{**INSTALLED[0], "version": "0.2.0"}]), "code": 0}})
    data = await (await client.post("/api/claude/skills/update")).json()
    assert data["updated"] and data["version"] == "0.2.0"
    assert fake_cli.calls()[:2] == [["plugin", "marketplace", "update", "gilzacode", "--json"],
                                    ["plugin", "update", "gilzacode-skills@gilzacode", "--json"]]


async def test_an_update_that_found_nothing_new_says_so(client, fake_cli):
    fake_cli({"plugin marketplace update": ok(), "plugin update": ok(updateOutcome="up_to_date"),
              "plugin list": {"stdout": json.dumps(INSTALLED), "code": 0}})
    data = await (await client.post("/api/claude/skills/update")).json()
    assert data["updated"] is False and data["installed"]


async def test_a_missing_claude_is_503(client, monkeypatch):
    def missing():
        raise claude_plugins.ClaudeCliError("Claude Code (`claude`) was not found.", kind="not_installed")

    monkeypatch.setattr(claude_plugins, "find_claude", missing)
    for method, path in (("get", "/api/claude/skills"), ("post", "/api/claude/skills/install"),
                         ("post", "/api/claude/skills/update")):
        response = await getattr(client, method)(path)
        assert response.status == 503
        assert (await response.json())["kind"] == "not_installed"


@pytest.mark.skipif(os.environ.get("GILZACODE_LIVE_CLAUDE") != "1", reason="set GILZACODE_LIVE_CLAUDE=1 to call the real claude")
async def test_live_install_from_github(client, tmp_path, monkeypatch):
    # A throwaway Claude Code configuration, so the user's own is never touched.
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    assert not (await (await client.get("/api/claude/skills")).json())["installed"]
    data = await (await client.post("/api/claude/skills/install")).json()
    assert data["installed"] and data["enabled"] and data["version"]
    data = await (await client.post("/api/claude/skills/update")).json()
    assert data["installed"] and data["updated"] is False
