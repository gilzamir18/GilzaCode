"""Agent history: turn snapshots in the shadow repository, review, and undoing a turn."""

import json
import subprocess

import pytest

from gilzacode import agent_history, claude_cli, mcp_bridge
from gilzacode.cloud.scanner import scan_project
from gilzacode.cloud.state import CloudSettings
from gilzacode.server.routes_ide import HUB_KEY


@pytest.fixture
def doc(tmp_path):
    folder = tmp_path / "doc"
    (folder / "ch").mkdir(parents=True)
    (folder / "main.tex").write_text("one\r\ntwo\r\n", encoding="utf-8", newline="")
    (folder / "ch" / "intro.tex").write_text("intro\n", encoding="utf-8")
    (folder / "old.md").write_text("old\n", encoding="utf-8")
    return folder


def a_turn(doc, change):
    """Run a turn that applies `change` to the project; the finished turn."""
    agent_history.begin_turn(str(doc), "Do the thing", "session-1")
    change()
    return agent_history.end_turn(str(doc))


def edit_three(doc):
    (doc / "main.tex").write_text("one\r\nTWO\r\n", encoding="utf-8", newline="")
    (doc / "new.tex").write_text("new\n", encoding="utf-8")
    (doc / "old.md").unlink()


def test_a_turn_records_what_it_changed(doc):
    turn = a_turn(doc, lambda: edit_three(doc))
    assert sorted((f["status"], f["path"]) for f in turn["files"]) == [("A", "new.tex"), ("D", "old.md"),
                                                                     ("M", "main.tex")]
    assert turn["prompt"] == "Do the thing" and turn["ended_at"] >= turn["started_at"]
    text = agent_history.diff(str(doc), turn["id"], "main.tex")
    assert "-two" in text and "+TWO" in text
    listed = agent_history.list_turns(str(doc))
    assert [t["id"] for t in listed["turns"]] == [turn["id"]] and listed["running"] is False


def test_a_turn_that_changed_nothing_is_forgotten(doc):
    assert a_turn(doc, lambda: None) is None
    assert agent_history.list_turns(str(doc))["turns"] == []


def test_edits_between_turns_are_not_counted_as_the_next_turn(doc):
    a_turn(doc, lambda: (doc / "main.tex").write_text("x\n", encoding="utf-8"))
    (doc / "ch" / "intro.tex").write_text("the user wrote this\n", encoding="utf-8")  # between turns
    turn = a_turn(doc, lambda: (doc / "new.tex").write_text("n\n", encoding="utf-8"))
    assert [f["path"] for f in turn["files"]] == ["new.tex"]


def test_an_interrupted_turn_is_closed_by_the_next_prompt(doc):
    agent_history.begin_turn(str(doc), "first")
    (doc / "main.tex").write_text("changed\n", encoding="utf-8")
    assert agent_history.list_turns(str(doc))["running"] is True
    agent_history.begin_turn(str(doc), "second")  # no Stop came for "first"
    turns = agent_history.list_turns(str(doc))["turns"]
    assert [t["prompt"] for t in turns] == ["second", "first"]
    assert turns[1]["end"] and [f["path"] for f in turns[1]["files"]] == ["main.tex"]


def test_build_output_and_gilzacode_files_are_not_recorded(doc):
    def build():
        (doc / "main.aux").write_text("aux", encoding="utf-8")
        (doc / "main.synctex.gz").write_bytes(b"x")
        (doc / ".gilzacode").mkdir(exist_ok=True)
        (doc / ".gilzacode" / "latex_compile_debug.json").write_text("{}", encoding="utf-8")
    assert a_turn(doc, build) is None


def test_undo_puts_back_only_the_turns_files(doc):
    turn = a_turn(doc, lambda: edit_three(doc))
    (doc / "ch" / "intro.tex").write_text("later, by the user\n", encoding="utf-8")
    result = agent_history.undo(str(doc), turn["id"])
    assert sorted(result["restored"]) == ["main.tex", "old.md"] and result["deleted"] == ["new.tex"]
    assert (doc / "main.tex").read_bytes() == b"one\r\ntwo\r\n"  # byte for byte, CRLF kept
    assert (doc / "old.md").read_text(encoding="utf-8") == "old\n"
    assert not (doc / "new.tex").exists()
    assert (doc / "ch" / "intro.tex").read_text(encoding="utf-8") == "later, by the user\n"  # not the turn's
    assert agent_history.list_turns(str(doc))["turns"][0]["undone_at"]
    with pytest.raises(agent_history.AgentHistoryError) as exc:
        agent_history.undo(str(doc), turn["id"])
    assert exc.value.code == "undone"


def test_a_file_changed_after_the_turn_is_a_conflict_until_confirmed(doc):
    turn = a_turn(doc, lambda: edit_three(doc))
    (doc / "main.tex").write_text("the user kept editing\n", encoding="utf-8")
    with pytest.raises(agent_history.AgentHistoryError) as exc:
        agent_history.undo(str(doc), turn["id"])
    assert exc.value.code == "conflict" and exc.value.details["conflicts"] == ["main.tex"]
    assert (doc / "new.tex").exists()  # nothing was undone
    agent_history.undo(str(doc), turn["id"], force=True)
    assert (doc / "main.tex").read_bytes() == b"one\r\ntwo\r\n"


def test_nothing_is_undone_while_a_turn_runs(doc):
    turn = a_turn(doc, lambda: edit_three(doc))
    agent_history.begin_turn(str(doc), "working")
    with pytest.raises(agent_history.AgentHistoryError) as exc:
        agent_history.undo(str(doc), turn["id"])
    assert exc.value.code == "running"


def test_the_users_own_repository_is_never_touched(doc):
    def git(*args):
        return subprocess.run(["git", *args], cwd=doc, capture_output=True, text=True, check=True).stdout
    git("init", "-q")
    git("-c", "user.name=u", "-c", "user.email=u@x", "commit", "-q", "--allow-empty", "-m", "mine")
    log = git("log", "--oneline")
    turn = a_turn(doc, lambda: edit_three(doc))
    agent_history.undo(str(doc), turn["id"])
    assert git("log", "--oneline") == log
    # The history is ignored by the user's repository, so it is never offered for a commit.
    assert "agent-history" not in git("status", "--porcelain", "--untracked-files=all")
    assert (doc / ".gilzacode" / "agent-history" / "repo" / "HEAD").exists()


def test_a_folder_with_its_own_repository_is_reported(doc):
    (doc / "vendor" / "lib" / ".git").mkdir(parents=True)
    assert agent_history.list_turns(str(doc))["nested_repositories"] == ["vendor/lib"]


def test_the_agent_history_is_not_synced_to_the_cloud(doc):
    a_turn(doc, lambda: edit_three(doc))
    synced = scan_project(str(doc), CloudSettings()).entries
    assert not [path for path in synced if "agent-history" in path]
    assert "main.tex" in synced


async def test_the_endpoints_take_the_hooks_bearer_token_and_tell_the_window(anon, server, doc):
    queue = __import__("asyncio").Queue()
    server.app[HUB_KEY].listeners.append(queue)
    headers = {"Authorization": f"Bearer {server.session.bridge_token}"}
    start = await anon.post("/api/agent-history/turn-start", headers=headers,
                            json={"projectPath": str(doc), "prompt": "Shorten", "sessionId": "s"})
    assert start.status == 200
    (doc / "main.tex").write_text("short\n", encoding="utf-8")
    end = await (await anon.post("/api/agent-history/turn-end", headers=headers,
                                 json={"projectPath": str(doc)})).json()
    turn = end["turn"]
    events = [queue.get_nowait() for _ in range(queue.qsize())]
    assert [e["event"] for e in events] == ["started", "ended"]
    assert events[1]["turn"]["files"] == [{"status": "M", "path": "main.tex"}]

    listed = await (await anon.get("/api/agent-history", headers=headers, params={"projectPath": str(doc)})).json()
    assert listed["turns"][0]["id"] == turn["id"]
    diff = await (await anon.get("/api/agent-history/diff", headers=headers,
                                 params={"projectPath": str(doc), "turn": turn["id"], "path": "main.tex"})).json()
    assert "+short" in diff["diff"]

    (doc / "main.tex").write_text("edited again\n", encoding="utf-8")
    conflict = await anon.post("/api/agent-history/undo", headers=headers,
                               json={"projectPath": str(doc), "turn": turn["id"]})
    data = await conflict.json()
    assert conflict.status == 409 and data["code"] == "conflict" and data["conflicts"] == ["main.tex"]
    undone = await anon.post("/api/agent-history/undo", headers=headers,
                             json={"projectPath": str(doc), "turn": turn["id"], "force": True})
    assert undone.status == 200 and (doc / "main.tex").read_bytes() == b"one\r\ntwo\r\n"


async def test_a_missing_project_is_refused(client, tmp_path):
    response = await client.post("/api/agent-history/turn-start", json={"projectPath": str(tmp_path / "gone")})
    assert response.status == 400


def test_the_panel_session_carries_the_hooks(isolated_home, monkeypatch):
    monkeypatch.setattr(claude_cli, "find_claude", lambda: "claude.exe")
    argv = claude_cli.claude_session_argv()
    settings = json.loads(open(argv[argv.index("--settings") + 1], encoding="utf-8").read())
    hooks = settings["hooks"]
    assert set(hooks) == {"UserPromptSubmit", "Stop", "SessionEnd"}
    start = hooks["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert start.endswith("-m gilzacode.mcp_bridge hook turn-start") and start.startswith('"')
    assert "\\" not in start
    assert hooks["Stop"][0]["hooks"][0]["command"].endswith("hook turn-end")


def test_the_hook_reports_the_turn_edge_and_prints_nothing(monkeypatch, capsys, tmp_path):
    calls = []
    monkeypatch.setenv("GILZACODE_PROJECT", str(tmp_path))
    monkeypatch.setattr(mcp_bridge, "call_app", lambda method, path, **kw: calls.append((method, path, kw["body"])))
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps({"prompt": "Fix it", "session_id": "s1"})))
    assert mcp_bridge.main(["hook", "turn-start"]) == 0
    assert calls == [("POST", "/api/agent-history/turn-start",
                      {"projectPath": str(tmp_path), "sessionId": "s1", "prompt": "Fix it"})]
    assert capsys.readouterr().out == ""  # stdout would be added to the user's prompt


def test_a_hook_that_cannot_reach_gilzacode_says_so_and_does_not_block(monkeypatch, capsys):
    def unreachable(*_args, **_kwargs):
        raise mcp_bridge.ToolError("GilzaCode is not running (no connection file).")
    monkeypatch.setattr(mcp_bridge, "call_app", unreachable)
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO("{}"))
    assert mcp_bridge.main(["hook", "turn-end"]) == 1  # 2 would block the prompt
    assert "GilzaCode agent history: GilzaCode is not running" in capsys.readouterr().err
