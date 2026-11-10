import socket

import pytest
from aiohttp.test_utils import TestClient, TestServer

from gilzacode.server.app import create_app
from gilzacode.session import BOOTSTRAP_HEADER, LocalSession

HOST = "127.0.0.1"


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    """Every test gets its own GilzaCode home; the user's ~/.gilzacode is never touched."""
    home = tmp_path / "home"
    monkeypatch.setenv("GILZACODE_HOME", str(home))
    return home


def _free_port() -> int:
    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


@pytest.fixture
async def server(tmp_path):
    """A running server whose session matches the port it listens on (Host is checked)."""
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>shell</title>", encoding="utf-8")
    (static / "app.js").write_text("console.log(1)", encoding="utf-8")
    port = _free_port()
    session = LocalSession(HOST, port)
    test_server = TestServer(create_app(session, static), host=HOST, port=port)
    await test_server.start_server()
    test_server.session = session
    yield test_server
    await test_server.close()


@pytest.fixture
async def anon(server):
    """A client with no session cookie."""
    client = TestClient(server)
    await client.start_server()
    yield client
    await client.close()


@pytest.fixture
async def client(anon):
    """A client that went through the same bootstrap as the window."""
    response = await anon.post("/api/session", headers={BOOTSTRAP_HEADER: "1"})
    assert response.status == 200
    return anon


@pytest.fixture
def project(tmp_path):
    folder = tmp_path / "proj"
    folder.mkdir()
    (folder / "main.tex").write_text("\\documentclass{article}\r\n", encoding="utf-8", newline="")
    (folder / "figs").mkdir()
    (folder / "figs" / "a.png").write_bytes(b"\x89PNG fake")
    (folder / "main.aux").write_text("aux", encoding="utf-8")
    return folder
