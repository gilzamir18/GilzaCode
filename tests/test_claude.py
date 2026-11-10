"""The Claude Code integration: headless calls (Translate, Look up), the panel's session and pasting."""

import json
import os
import sys
import time

import pytest

from gilzacode import claude_cli, snippets
from gilzacode.server import routes_claude
from gilzacode.server.routes_terminal import CLAUDE_ID, SESSIONS_KEY

FAKE = r'''
import json, sys
prompt = sys.stdin.read()
argv = sys.argv[1:]
with open(sys.argv[0] + ".calls", "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": argv, "prompt": prompt}) + "\n")
mode = open(sys.argv[0] + ".mode", encoding="utf-8").read().strip()
events = []
if mode == "read":
    events.append({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Read", "input": {"file_path": READ_PATH}}]}})
if mode == "error":
    events.append({"type": "result", "is_error": True, "result": "model refused"})
else:
    events.append({"type": "result", "is_error": False, "result": ANSWER})
for e in events:
    print(json.dumps(e))
'''


@pytest.fixture
def fake_claude(tmp_path, monkeypatch):
    """A `claude` stand-in that records its argv and stdin and prints stream-json."""
    script = tmp_path / "fake_claude.py"

    def configure(answer="ok", mode="plain", read_path=""):
        script.write_text(FAKE.replace("ANSWER", json.dumps(answer)).replace("READ_PATH", json.dumps(read_path)),
                          encoding="utf-8")
        (tmp_path / "fake_claude.py.mode").write_text(mode, encoding="utf-8")

    real_argv = claude_cli.headless_argv
    monkeypatch.setattr(claude_cli, "find_claude", lambda: sys.executable)
    monkeypatch.setattr(claude_cli, "headless_argv",
                        lambda exe, **kw: [sys.executable, str(script), *real_argv(exe, **kw)[1:]])
    configure()

    def calls():
        path = tmp_path / "fake_claude.py.calls"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    configure.calls = calls
    return configure


def test_headless_calls_are_isolated_and_name_their_tools():
    argv = claude_cli.headless_argv("claude", system_prompt="S", model="haiku", tools=())
    assert argv[:2] == ["claude", "-p"]
    assert argv[argv.index("--tools") + 1] == ""
    assert "--allowedTools" not in argv
    for flag in ("--strict-mcp-config", "--no-session-persistence"):
        assert flag in argv
    assert argv[argv.index("--setting-sources") + 1] == ""
    assert "--bare" not in argv  # it would reject a claude.ai login
    read_only = claude_cli.headless_argv("claude", system_prompt="S", model="sonnet", tools=("Read", "Grep", "Glob"))
    assert read_only[read_only.index("--tools") + 1] == "Read,Grep,Glob"
    assert read_only[read_only.index("--allowedTools") + 1] == "Read,Grep,Glob"


def test_nested_session_markers_are_not_inherited():
    env = claude_cli.child_environment({"CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "PATH": "x"})
    assert env == {"PATH": "x"}


def test_a_missing_claude_is_reported_with_what_to_do(monkeypatch):
    monkeypatch.delenv("GILZACODE_CLAUDE", raising=False)
    monkeypatch.setattr("shutil.which", lambda name: None)
    with pytest.raises(claude_cli.ClaudeCliError) as exc:
        claude_cli.find_claude()
    assert exc.value.kind == "not_installed" and "PATH" in str(exc.value)


def test_stream_parsing():
    lines = "\n".join(json.dumps(e) for e in [
        {"type": "system", "subtype": "init"},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "a.tex"}},
                                                      {"type": "tool_use", "name": "Grep", "input": {"pattern": "x"}}]}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "a.tex"}}]}},
        {"type": "result", "is_error": False, "result": "answer"},
    ])
    parsed = claude_cli.parse_stream("noise\n" + lines)
    assert parsed.text == "answer" and parsed.files_read == ["a.tex"]
    with pytest.raises(claude_cli.ClaudeCliError):
        claude_cli.parse_stream(json.dumps({"type": "result", "is_error": True, "result": "boom"}))
    with pytest.raises(claude_cli.ClaudeCliError):
        claude_cli.parse_stream("")


async def test_translate_sends_the_excerpt_on_stdin_with_no_tools(client, fake_claude):
    fake_claude(answer="```\nO método reduz o erro.\n```")
    excerpt = "The method reduces the error. " * 600  # ~18 000 characters: too long for an argument
    response = await client.post("/api/translate", json={"text": excerpt, "target_lang": "pt-BR"})
    data = await response.json()
    assert data == {"success": True, "target_language": "Brazilian Portuguese", "translated_text": "O método reduz o erro."}
    call = fake_claude.calls()[-1]
    assert call["prompt"] == excerpt.strip()
    assert call["argv"][call["argv"].index("--tools") + 1] == ""
    assert "Brazilian Portuguese" in call["argv"][call["argv"].index("--system-prompt") + 1]
    assert call["argv"][call["argv"].index("--model") + 1] == snippets.DEFAULT_TRANSLATE_MODEL


async def test_translate_refuses_what_it_cannot_do_whole(client, fake_claude):
    long = await client.post("/api/translate", json={"text": "x" * (snippets.MAX_TRANSLATION_CHARS + 1)})
    assert long.status == 400
    fake_claude(mode="error")
    failed = await client.post("/api/translate", json={"text": "hello"})
    assert failed.status == 502 and "model refused" in (await failed.json())["error"]
    assert fake_claude.calls()[-1]["prompt"] == "hello"


async def test_look_up_reads_the_project_read_only(client, fake_claude, project):
    fake_claude(answer="In **Results**.", mode="read", read_path=str(project / "main.tex"))
    response = await client.post("/api/snippet-query", json={
        "excerpt": "E = mc^2", "question": "Where is this?", "projectPath": str(project),
        "source": {"surface": "pdf", "documentPath": "main.pdf", "page": 2, "totalPages": 3}})
    data = await response.json()
    assert data == {"success": True, "answer": "In **Results**.", "truncated": False, "files_read": ["main.tex"]}
    call = fake_claude.calls()[-1]
    assert call["argv"][call["argv"].index("--tools") + 1] == "Read,Grep,Glob"
    assert "Page: 2 of 3" in call["prompt"] and "<excerpt>\nE = mc^2\n</excerpt>" in call["prompt"]


async def test_look_up_without_a_project_gets_no_tools(client, fake_claude):
    await client.post("/api/snippet-query", json={"excerpt": "x", "question": "y"})
    call = fake_claude.calls()[-1]
    assert call["argv"][call["argv"].index("--tools") + 1] == ""


async def test_translation_settings(client):
    await client.post("/api/settings/translation", json={"translate_target_lang": "es"})
    data = await (await client.get("/api/settings/translation")).json()
    assert data["translate_target_lang"] == "es" and "pt-BR" in data["known_languages"]


def test_a_paste_cannot_carry_keystrokes():
    pasted = routes_claude.bracketed_paste("line 1\nline 2\x1b[201~\r\nrm -rf /\r")
    assert pasted.startswith("\x1b[200~") and pasted.endswith("\x1b[201~")
    body = pasted[len("\x1b[200~"):-len("\x1b[201~")]
    assert "\x1b" not in body
    assert body == "line 1\rline 2[201~\rrm -rf /\r"


class FakeSession:
    def __init__(self, project_path, running=True, idle=10.0):
        self.project_path = project_path
        self.is_running = running
        self.exited = not running
        self.started_at = time.monotonic() - 30
        self.last_output_at = time.monotonic() - idle
        self.written = []

    def write(self, data):
        self.written.append(data)

    def close(self):
        self.is_running, self.exited = False, True


async def test_paste_goes_to_the_running_session_unsent(client, project):
    session = FakeSession(str(project))
    client.server.app[SESSIONS_KEY][CLAUDE_ID] = session
    response = await client.post("/api/claude/paste", json={"projectPath": str(project), "text": "Ask about this"})
    assert (await response.json()) == {"pasted": True}
    assert session.written == ["\x1b[200~Ask about this\x1b[201~"]  # no Enter


async def test_paste_waits_for_quiet_and_refuses_a_busy_or_absent_session(client, project, monkeypatch):
    monkeypatch.setattr(routes_claude, "PASTE_WAIT_SECONDS", 0.3)
    absent = await client.post("/api/claude/paste", json={"projectPath": str(project), "text": "x"})
    assert absent.status == 409 and (await absent.json())["kind"] == "not_running"
    busy = FakeSession(str(project), idle=0.0)
    busy.last_output_at = time.monotonic() + 60  # keeps printing
    client.server.app[SESSIONS_KEY][CLAUDE_ID] = busy
    response = await client.post("/api/claude/paste", json={"projectPath": str(project), "text": "x"})
    assert response.status == 409 and (await response.json())["kind"] == "busy"
    assert busy.written == []
    other = FakeSession(str(project.parent))
    client.server.app[SESSIONS_KEY][CLAUDE_ID] = other
    elsewhere = await client.post("/api/claude/paste", json={"projectPath": str(project), "text": "x"})
    assert elsewhere.status == 409 and other.written == []


async def test_an_exited_session_is_not_restarted_by_reconnecting(client, project):
    client.server.app[SESSIONS_KEY][CLAUDE_ID] = FakeSession(str(project), running=False)
    stream = await client.get("/api/terminal/stream", params={"term_id": CLAUDE_ID, "projectPath": str(project)})
    assert stream.status == 410
    status = await (await client.get("/api/claude/status", params={"projectPath": str(project)})).json()
    assert status["running"] is False and status["exited"] is True


async def test_deleting_a_project_folder_closes_only_the_sessions_in_it(client, project):
    await client.post("/api/projects/import", json={"project_path": str(project)})
    sibling = project.parent / (project.name + "-other")  # shares the prefix, not the folder
    sibling.mkdir()
    sessions = client.server.app[SESSIONS_KEY]
    sessions[CLAUDE_ID] = claude = FakeSession(str(project))
    sessions["main"] = inside = FakeSession(str(project / "figs"))
    sessions["main-2"] = elsewhere = FakeSession(str(sibling))

    await client.post("/api/projects/delete", json={"name": "proj"})  # unregistering only
    assert claude.is_running and inside.is_running

    await client.post("/api/projects/import", json={"project_path": str(project)})
    response = await client.post("/api/projects/delete", json={"name": "proj", "delete_dir": True})
    assert response.status == 200 and not project.exists()
    assert not claude.is_running and not inside.is_running
    assert elsewhere.is_running


async def test_the_claude_id_cannot_be_started_as_a_shell_tab(client, project):
    response = await client.post("/api/terminal/start", json={"term_id": CLAUDE_ID, "projectPath": str(project)})
    assert response.status == 400


@pytest.mark.skipif(os.environ.get("GILZACODE_LIVE_CLAUDE") != "1", reason="set GILZACODE_LIVE_CLAUDE=1 to call the real claude")
async def test_live_translation(client):
    data = await (await client.post("/api/translate", json={"text": "Good morning", "target_lang": "pt-BR"})).json()
    assert data["success"] and "bom dia" in data["translated_text"].lower()
