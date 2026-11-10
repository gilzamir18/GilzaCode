"""The local session boundary: only this server's own origin, and only with the session."""

import asyncio

import pytest

from gilzacode.server import app as server_app
from gilzacode.session import BOOTSTRAP_HEADER, connection_file, remove_connection_file, write_connection_file


async def test_api_without_the_session_is_refused(anon):
    response = await anon.get("/api/app/environment")
    assert response.status == 401


async def test_bootstrap_requires_the_custom_header(anon):
    response = await anon.post("/api/session")
    assert response.status == 403
    assert "Set-Cookie" not in response.headers


async def test_bootstrap_issues_a_strict_http_only_cookie_scoped_to_the_api(anon, server):
    response = await anon.post("/api/session", headers={BOOTSTRAP_HEADER: "1"})
    cookie = response.headers["Set-Cookie"]
    assert cookie.startswith(f"gilzacode_session_{server.port}=")
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie and "Path=/api/" in cookie
    assert (await anon.get("/api/session")).status == 200


@pytest.mark.parametrize("headers", [
    {"Host": "evil.example:1234"},
    {"Origin": "http://evil.example"},
    {"Origin": "http://127.0.0.1:1"},
    {"Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "same-site"},
])
async def test_foreign_hosts_and_origins_are_refused_before_anything_else(client, headers):
    response = await client.get("/api/app/environment", headers=headers)
    assert response.status == 403


async def test_a_foreign_page_gets_no_bootstrap_cookie(anon):
    response = await anon.post("/api/session", headers={BOOTSTRAP_HEADER: "1", "Origin": "http://evil.example"})
    assert response.status == 403
    assert "Set-Cookie" not in response.headers


async def test_the_bridge_token_authenticates_without_a_cookie(anon, server):
    ok = await anon.get("/api/app/environment",
                        headers={"Authorization": f"Bearer {server.session.bridge_token}"})
    assert ok.status == 200
    wrong = await anon.get("/api/app/environment", headers={"Authorization": "Bearer nope"})
    assert wrong.status == 401


async def test_the_static_shell_is_served_with_framing_refused(anon):
    response = await anon.get("/")
    assert response.status == 200
    assert "shell" in await response.text()
    assert response.headers["X-Frame-Options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in response.headers["Content-Security-Policy"]


async def test_unknown_routes_fall_back_to_the_shell_but_unknown_api_is_404(client):
    assert "shell" in await (await client.get("/some/route")).text()
    response = await client.get("/api/does-not-exist")
    assert response.status == 404
    assert "error" in await response.json()


@pytest.mark.parametrize("path", ["/..%2Fsecret.txt", "/%2E%2E/secret.txt", "/..\\secret.txt"])
async def test_static_files_cannot_escape_their_folder(anon, tmp_path, path):
    (tmp_path / "secret.txt").write_text("TOP SECRET", encoding="utf-8")
    response = await anon.get(path)
    assert "TOP SECRET" not in await response.text()


async def test_api_responses_are_not_cached(client):
    response = await client.get("/api/app/environment")
    assert response.headers["Cache-Control"] == "no-store"


async def test_exclusive_work_keeps_arrival_order(client, monkeypatch, project):
    """A request arriving during the tree walk is handled after it, not interleaved."""
    order = []
    started = asyncio.Event()
    release = asyncio.Event()
    loop = asyncio.get_running_loop()

    def slow_tree(*_args, **_kwargs):
        loop.call_soon_threadsafe(started.set)
        asyncio.run_coroutine_threadsafe(release.wait(), loop).result()
        order.append("tree")
        return []

    monkeypatch.setattr("gilzacode.server.routes_files.file_tree", slow_tree)
    tree = asyncio.create_task(client.get("/api/files", params={"projectPath": str(project)}))
    await started.wait()

    async def later():
        await client.get("/api/app/environment")
        order.append("environment")

    second = asyncio.create_task(later())
    await asyncio.sleep(0.2)
    assert order == []  # the second request is waiting, not running
    release.set()
    await tree
    await second
    assert order == ["tree", "environment"]
    assert "/api/files" in server_app.EXCLUSIVE_WORK_PATHS


def test_connection_file_belongs_to_its_session(isolated_home):
    from gilzacode.session import LocalSession
    import json

    first, second = LocalSession("127.0.0.1", 3100), LocalSession("127.0.0.1", 3101)
    path = write_connection_file(first)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["url"] == "http://127.0.0.1:3100" and data["token"] == first.bridge_token
    remove_connection_file(second)  # another instance must not remove it
    assert connection_file().exists()
    remove_connection_file(first)
    assert not connection_file().exists()
