"""The integrated terminal through the API, with a real PowerShell under winpty."""

import asyncio
import base64
import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="the terminal uses winpty on Windows")


async def _read_until(response, marker: str, timeout: float = 30.0) -> tuple[str, int]:
    """Decode SSE chunks until `marker` appears; return the text and the last event id."""
    text, last_id = "", 0
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while marker not in text:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise AssertionError(f"{marker!r} not seen; got {text[-500:]!r}")
        line = (await asyncio.wait_for(response.content.readline(), remaining)).decode("ascii").strip()
        if line.startswith("id: "):
            last_id = int(line[4:])
        elif line.startswith("data: "):
            text += base64.b64decode(line[6:]).decode("utf-8", "replace")
    return text, last_id


async def test_a_shell_runs_in_the_project_and_echoes(client, project):
    stream = await client.get("/api/terminal/stream", params={"term_id": "main-7", "projectPath": str(project)})
    assert stream.status == 200 and stream.headers["Content-Type"].startswith("text/event-stream")
    try:
        await client.post("/api/terminal/input", json={
            "term_id": "main-7", "projectPath": str(project), "action": "resize", "cols": 120, "rows": 30})
        await client.post("/api/terminal/input", json={
            "term_id": "main-7", "projectPath": str(project), "text": "Write-Output ('gil' + 'zacode'); (Get-Location).Path\r"})
        text, last_id = await _read_until(stream, "gilzacode")
        assert last_id > 0
        await _read_until(stream, project.name)

        output = await (await client.get("/api/terminal/output", params={
            "term_id": "main-7", "projectPath": str(project)})).json()
        assert "gilzacode" in output["text"]
        other = await client.get("/api/terminal/output", params={"term_id": "main-7", "projectPath": str(project.parent)})
        assert other.status == 409
    finally:
        stream.close()


async def test_a_reconnecting_client_only_gets_what_it_missed(client, project):
    first = await client.get("/api/terminal/stream", params={"term_id": "main-8", "projectPath": str(project)})
    await client.post("/api/terminal/input", json={
        "term_id": "main-8", "projectPath": str(project), "text": "Write-Output ('one' + 'marker')\r"})
    _text, seen = await _read_until(first, "onemarker")
    first.close()
    await client.post("/api/terminal/input", json={
        "term_id": "main-8", "projectPath": str(project), "text": "Write-Output ('two' + 'marker')\r"})
    second = await client.get("/api/terminal/stream", params={"term_id": "main-8", "projectPath": str(project)},
                              headers={"Last-Event-ID": str(seen)})
    try:
        text, _ = await _read_until(second, "twomarker")
        assert "onemarker" not in text
    finally:
        second.close()


async def test_unknown_terminal_ids_and_missing_projects_are_refused(client, project):
    assert (await client.get("/api/terminal/stream", params={"term_id": "agent", "projectPath": str(project)})).status == 400
    assert (await client.get("/api/terminal/stream", params={"term_id": "main"})).status == 400
    assert (await client.post("/api/terminal/input", json={"term_id": "main", "text": "x"})).status == 400
    response = await client.get("/api/terminal/output", params={"term_id": "main-99", "projectPath": str(project)})
    assert response.status == 404  # reading never starts a shell


async def test_deleting_a_project_closes_the_terminals_running_in_its_folder(client, project):
    """Windows refuses to delete a folder that is a process' working directory."""
    await client.post("/api/projects/import", json={"project_path": str(project)})
    stream = await client.get("/api/terminal/stream", params={"term_id": "main-9", "projectPath": str(project)})
    try:
        await client.post("/api/terminal/input", json={
            "term_id": "main-9", "projectPath": str(project), "text": "Write-Output ('rea' + 'dy')\r"})
        await _read_until(stream, "ready")
        response = await client.post("/api/projects/delete", json={"name": "proj", "delete_dir": True})
        assert response.status == 200, await response.text()
        assert not project.exists()
    finally:
        stream.close()


async def _events_until_closed(response, timeout: float = 30.0) -> list[tuple[str, str]]:
    """(event type, decoded data) for every SSE event until the server ends the stream."""
    events, kind, data = [], "message", ""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        raw = await asyncio.wait_for(response.content.readline(), deadline - loop.time())
        if not raw:
            return events
        line = raw.decode("ascii").rstrip("\r\n")
        if line.startswith("event: "):
            kind = line[7:]
        elif line.startswith("data: "):
            data = line[6:]
        elif not line:
            text = base64.b64decode(data).decode("utf-8", "replace") if kind == "message" else data
            events.append((kind, text))
            kind, data = "message", ""


def _python_session(monkeypatch, code: str) -> None:
    """Run the Claude session as a Python one-liner instead of the real CLI."""
    from gilzacode.server import routes_terminal
    from gilzacode.terminal_manager import TerminalSession
    monkeypatch.setattr(routes_terminal, "_new_session",
                        lambda term_id, path: TerminalSession(path, argv=[sys.executable, "-c", code]))


async def test_claude_exiting_by_itself_ends_the_stream_with_an_ended_event(client, project, monkeypatch):
    _python_session(monkeypatch, "print('bye' + 'now')")
    stream = await client.get("/api/terminal/stream", params={"term_id": "claude", "projectPath": str(project)})
    events = await _events_until_closed(stream)
    assert "byenow" in "".join(text for kind, text in events if kind == "message")
    assert events[-1][0] == "ended"  # after all the output, so nothing is lost


async def test_a_claude_session_closed_by_the_server_sends_no_ended_event(client, project, monkeypatch):
    """A restart or a project switch closes the old session; its stream must not say Claude ended."""
    from gilzacode.server.routes_terminal import SESSIONS_KEY
    _python_session(monkeypatch, "import time; print('wait' + 'ing', flush=True); time.sleep(60)")
    stream = await client.get("/api/terminal/stream", params={"term_id": "claude", "projectPath": str(project)})
    await _read_until(stream, "waiting")
    client.server.app[SESSIONS_KEY]["claude"].close()
    events = await _events_until_closed(stream)
    assert all(kind == "message" for kind, _ in events)
