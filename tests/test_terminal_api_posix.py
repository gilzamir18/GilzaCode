"""The integrated terminal through the API on Linux, with a real bash in a PTY.

The Windows counterpart, with PowerShell under winpty, is test_terminal_api.py.
"""

import sys

import pytest

from test_terminal_api import _read_until

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the POSIX terminal is a pty running bash")


async def test_a_shell_runs_in_the_project_and_echoes(client, project):
    stream = await client.get("/api/terminal/stream", params={"term_id": "main-7", "projectPath": str(project)})
    assert stream.status == 200 and stream.headers["Content-Type"].startswith("text/event-stream")
    try:
        await client.post("/api/terminal/input", json={
            "term_id": "main-7", "projectPath": str(project), "action": "resize", "cols": 120, "rows": 30})
        # The quotes keep the marker out of the echoed command line, and both
        # outputs are awaited in one read: they can arrive in a single chunk.
        await client.post("/api/terminal/input", json={
            "term_id": "main-7", "projectPath": str(project), "text": "echo gil''zacode; echo \"[$PWD]\"\r"})
        text, last_id = await _read_until(stream, f"[{project}]")
        assert last_id > 0
        assert "gilzacode" in text

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
        "term_id": "main-8", "projectPath": str(project), "text": "echo one''marker\r"})
    _text, seen = await _read_until(first, "onemarker")
    first.close()
    await client.post("/api/terminal/input", json={
        "term_id": "main-8", "projectPath": str(project), "text": "echo two''marker\r"})
    second = await client.get("/api/terminal/stream", params={"term_id": "main-8", "projectPath": str(project)},
                              headers={"Last-Event-ID": str(seen)})
    try:
        text, _ = await _read_until(second, "twomarker")
        assert "onemarker" not in text
    finally:
        second.close()


async def test_deleting_a_project_closes_the_terminals_running_in_its_folder(client, project):
    from gilzacode.server.routes_terminal import SESSIONS_KEY
    await client.post("/api/projects/import", json={"project_path": str(project)})
    stream = await client.get("/api/terminal/stream", params={"term_id": "main-9", "projectPath": str(project)})
    try:
        await client.post("/api/terminal/input", json={
            "term_id": "main-9", "projectPath": str(project), "text": "echo rea''dy\r"})
        await _read_until(stream, "ready")
        session = client.server.app[SESSIONS_KEY]["main-9"]
        response = await client.post("/api/projects/delete", json={"name": "proj", "delete_dir": True})
        assert response.status == 200, await response.text()
        assert not project.exists()
        assert not session.is_running
    finally:
        stream.close()
