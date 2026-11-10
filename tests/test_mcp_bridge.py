"""The MCP bridge (stdio, run as Claude Code runs it) and the window command channel."""

import asyncio
import json
import os
import subprocess
import sys

import pytest

from gilzacode import mcp_bridge
from gilzacode.server import routes_ide
from gilzacode.session import BOOTSTRAP_HEADER, write_connection_file


class Bridge:
    """`python -m gilzacode.mcp_bridge` over pipes, as Claude Code starts it."""

    def __init__(self, env):
        self.proc = subprocess.Popen([sys.executable, "-m", "gilzacode.mcp_bridge"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True,
                                     encoding="utf-8")
        self.next_id = 0

    def request(self, method, params=None):
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method,
                                          "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    async def arequest(self, method, params=None):
        return await asyncio.to_thread(self.request, method, params)

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)


@pytest.fixture
def bridge_env(isolated_home, project):
    env = dict(os.environ, GILZACODE_HOME=str(isolated_home), GILZACODE_PROJECT=str(project))
    return env


def test_the_bridge_stays_on_the_handshake_protocol(bridge_env):
    bridge = Bridge(bridge_env)
    try:
        probe = bridge.request("server/discover", {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}})
        assert probe["error"]["code"] == -32601
        init = bridge.request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}})
        assert init["result"]["protocolVersion"] == "2025-11-25"
        assert "GilzaCode" in init["result"]["instructions"]
        modern = bridge.request("initialize", {"protocolVersion": "2026-07-28"})
        assert modern["result"]["protocolVersion"] in mcp_bridge.HANDSHAKE_VERSIONS
        names = [tool["name"] for tool in bridge.request("tools/list")["result"]["tools"]]
        assert names == ["get_editor_state", "get_pdf_view", "open_file", "close_file", "reveal_in_pdf",
                         "set_layout", "get_problems", "compile_latex", "list_pdf_annotations"]
    finally:
        bridge.close()


def test_without_gilzacode_running_a_tool_says_so(bridge_env):
    bridge = Bridge(bridge_env)
    try:
        answer = bridge.request("tools/call", {"name": "get_editor_state", "arguments": {}})
        assert answer["result"]["isError"] is True
        assert "not running" in answer["result"]["content"][0]["text"]
    finally:
        bridge.close()


async def fake_window(client, answers, seen):
    """Listen to /api/ide/events like the window and answer each command with `answers(command)`."""
    async with client.get("/api/ide/events") as stream:
        while True:
            line = (await stream.content.readline()).decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            seen.append(event)
            if event["type"] == "command":
                await client.post("/api/ide/result", json={**answers(event), "id": event["id"]})


async def wait_listening(server):
    hub = server.app[routes_ide.HUB_KEY]
    for _ in range(50):
        if hub.listeners:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("the fake window never connected")


async def test_a_command_with_no_window_fails_at_once(client, project):
    response = await client.post("/api/ide/command", json={"action": "get_problems", "project_path": str(project)})
    assert response.status == 409 and "not open" in (await response.json())["error"]


async def test_the_bridge_reaches_the_window_and_back(client, server, project, bridge_env):
    """Claude Code → bridge (subprocess) → app → window → app → bridge, with real HTTP and the real token."""
    write_connection_file(server.session)
    seen = []

    def answers(command):
        if command["action"] == "get_editor_state":
            return {"ok": True, "current_file": "main.tex", "selection": {"text": "E = mc^2", "start_line": 10}}
        return {"ok": False, "error": "main.png is not a file the IDE opens in a tab"}

    window = asyncio.create_task(fake_window(client, answers, seen))
    await wait_listening(server)
    bridge = Bridge(bridge_env)
    try:
        await bridge.arequest("initialize", {"protocolVersion": "2025-11-25"})
        state = await bridge.arequest("tools/call", {"name": "get_editor_state", "arguments": {}})
        assert "isError" not in state["result"]
        assert json.loads(state["result"]["content"][0]["text"]) == {
            "current_file": "main.tex", "selection": {"text": "E = mc^2", "start_line": 10}}
        refused = await bridge.arequest("tools/call", {"name": "open_file", "arguments": {"path": "main.png"}})
        assert refused["result"]["isError"] is True and "not a file the IDE opens" in refused["result"]["content"][0]["text"]
    finally:
        bridge.close()
        window.cancel()
    commands = [e for e in seen if e["type"] == "command"]
    assert [c["action"] for c in commands] == ["get_editor_state", "open_file"]
    assert all(c["project_path"] == str(project) for c in commands)
    assert commands[1]["args"] == {"path": "main.png"}


async def test_an_unanswered_command_times_out_with_a_reason(client, server, project, monkeypatch):
    monkeypatch.setattr("gilzacode.ide_control.IDE_COMMAND_TIMEOUT", 0.3)
    hub = server.app[routes_ide.HUB_KEY]
    hub.listeners.append(asyncio.Queue())  # a window that never answers
    original = hub.send_command

    async def quick(action, args, *, project_path, timeout=0.3):
        return await original(action, args, project_path=project_path, timeout=timeout)

    monkeypatch.setattr(hub, "send_command", quick)
    response = await client.post("/api/ide/command", json={"action": "get_problems", "project_path": str(project)})
    assert response.status == 409 and "did not answer" in (await response.json())["error"]


async def test_compile_reads_the_disk_and_tells_the_window(client, server, project, monkeypatch):
    received = {}

    async def fake_compile(app, data):
        received.update(data)
        return {"success": False, "log": "! Undefined control sequence.", "compiled_main_file": "main.tex",
                "pdf_path": str(project / "main.pdf")}

    monkeypatch.setattr("gilzacode.server.routes_latex.run_compile", fake_compile)
    seen = []
    window = asyncio.create_task(fake_window(client, lambda c: {"ok": True}, seen))
    await wait_listening(server)
    try:
        data = await (await client.post("/api/ide/compile", json={"projectPath": str(project), "filePath": "main.tex"})).json()
        await asyncio.sleep(0.2)
    finally:
        window.cancel()
    assert received["content"] == (project / "main.tex").read_bytes().decode("utf-8")  # exactly as on disk
    assert data == {"success": False, "compiled_main_file": "main.tex", "pdf_path": "main.pdf",
                    "log": "! Undefined control sequence."}
    notices = [e for e in seen if e["type"] == "latex_compiled"]
    assert notices and notices[0]["success"] is False and notices[0]["filePath"] == "main.tex"


async def test_compile_refuses_what_is_not_project_latex(client, project, tmp_path):
    for file_path, status in (("../outside.tex", 403), ("figs/a.png", 400), ("missing.tex", 400)):
        response = await client.post("/api/ide/compile", json={"projectPath": str(project), "filePath": file_path})
        assert response.status == status, file_path


def test_the_panel_starts_claude_with_the_bridge(isolated_home, monkeypatch, tmp_path):
    from gilzacode import claude_cli
    monkeypatch.setattr(claude_cli, "find_claude", lambda: "claude.exe")
    argv = claude_cli.claude_session_argv()
    assert argv[0] == "claude.exe" and argv[1] == "--mcp-config"
    config = json.loads(open(argv[2], encoding="utf-8").read())
    assert config["mcpServers"]["gilzacode"]["args"] == ["-m", "gilzacode.mcp_bridge"]
    allowed = argv[argv.index("--allowedTools") + 1].split(",")
    assert "mcp__gilzacode__get_editor_state" in allowed
    assert "mcp__gilzacode__compile_latex" not in allowed  # it writes files, so Claude Code asks
    env = claude_cli.claude_session_env(str(tmp_path))
    assert env["GILZACODE_PROJECT"] == str(tmp_path) and "CLAUDECODE" not in env
