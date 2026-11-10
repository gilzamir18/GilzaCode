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
