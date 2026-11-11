"""Clipboard (Win32), external links, environment; the launcher's server."""

import base64
import io
import json
import sys
import urllib.request

import pytest
from PIL import Image

from gilzacode import __version__, win_clipboard
from gilzacode.launcher import BackgroundServer, find_available_port
from gilzacode.session import BOOTSTRAP_HEADER, connection_file


def test_line_ends_are_converted_both_ways():
    assert win_clipboard.to_clipboard_text("a\nb\r\nc") == "a\r\nb\r\nc"
    assert win_clipboard.from_clipboard_text("a\r\nb\r\n") == "a\nb\n"


def test_an_image_on_the_clipboard_comes_back_as_png():
    png = win_clipboard.read_image_png_b64(grab=lambda: Image.new("RGB", (3, 2), "red"))
    image = Image.open(io.BytesIO(base64.b64decode(png)))
    assert (image.format, image.size) == ("PNG", (3, 2))


@pytest.mark.parametrize("content", [None, ["C:\\Users\\u\\shot.png"]])
def test_no_image_and_copied_files_are_no_image(content):
    assert win_clipboard.read_image_png_b64(grab=lambda: content) == ""


@pytest.mark.skipif(sys.platform != "win32", reason="the Win32 clipboard exists only on Windows")
def test_text_round_trips_through_the_real_clipboard():
    """Writes the real clipboard; whatever text it held is put back afterwards."""
    saved = win_clipboard.read_text()
    try:
        win_clipboard.write_text("linha 1\nação ✓")
        assert win_clipboard.read_text() == "linha 1\nação ✓"
    finally:
        win_clipboard.write_text(saved)


async def test_clipboard_endpoints(client, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    written = []
    monkeypatch.setattr(win_clipboard, "read_text", lambda: "from win32")
    monkeypatch.setattr(win_clipboard, "write_text", written.append)
    monkeypatch.setattr(win_clipboard, "read_image_png_b64", lambda: "cG5n")
    assert (await (await client.get("/api/clipboard/read")).json()) == {"text": "from win32"}
    assert (await (await client.post("/api/clipboard/write", json={"text": "hi"})).json()) == {"ok": True}
    assert written == ["hi"]
    assert (await (await client.get("/api/clipboard/read-image")).json()) == {"data_b64": "cG5n", "mime": "image/png"}


async def test_a_clipboard_write_failure_is_reported(client, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")

    def fail(_text):
        raise win_clipboard.ClipboardError("the clipboard is held by another program")

    monkeypatch.setattr(win_clipboard, "write_text", fail)
    response = await client.post("/api/clipboard/write", json={"text": "x"})
    assert response.status == 500
    assert (await response.json()) == {"ok": False, "error": "the clipboard is held by another program"}


@pytest.mark.parametrize("url", ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-settings:", ""])
async def test_only_web_links_are_opened(client, monkeypatch, url):
    monkeypatch.setattr("webbrowser.open", lambda *a, **k: pytest.fail("must not open"))
    assert (await client.post("/api/system/open-url", json={"url": url})).status == 400


async def test_web_links_are_opened(client, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    opened = []
    monkeypatch.setattr("webbrowser.open", lambda url, *a, **k: opened.append(url) or True)
    data = await (await client.post("/api/system/open-url", json={"url": "https://example.com"})).json()
    assert data == {"opened": True} and opened == ["https://example.com"]


async def test_web_links_open_through_the_desktop_on_linux(client, monkeypatch):
    """Not `webbrowser`, which would hand a packaged build's library path to the browser."""
    from gilzacode import desktop
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr("webbrowser.open", lambda *a, **k: pytest.fail("webbrowser must not be used on Linux"))
    opened = []
    monkeypatch.setattr(desktop, "open_url", lambda url: opened.append(url) or True)
    data = await (await client.post("/api/system/open-url", json={"url": "https://example.com"})).json()
    assert data == {"opened": True} and opened == ["https://example.com"]


async def test_environment(client):
    data = await (await client.get("/api/app/environment")).json()
    assert data["version"] == __version__


def test_find_available_port_skips_a_port_in_use():
    import socket

    with socket.socket() as held:
        held.bind(("127.0.0.1", 0))
        held.listen()
        taken = held.getsockname()[1]
        assert find_available_port("127.0.0.1", taken, taken + 20) != taken


def test_the_background_server_serves_and_publishes_its_connection(isolated_home, tmp_path):
    """The real launcher path: thread, event loop, connection file, bridge token."""
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<title>x</title>", encoding="utf-8")
    port = find_available_port("127.0.0.1")
    server = BackgroundServer("127.0.0.1", port, static)
    server.start()
    try:
        info = json.loads(connection_file().read_text(encoding="utf-8"))
        assert info["url"] == server.url
        request = urllib.request.Request(f"{server.url}/api/app/environment",
                                         headers={"Authorization": f"Bearer {info['token']}"})
        assert json.loads(urllib.request.urlopen(request, timeout=5).read())["version"] == __version__
        boot = urllib.request.Request(f"{server.url}/api/session", method="POST", headers={BOOTSTRAP_HEADER: "1"})
        assert urllib.request.urlopen(boot, timeout=5).status == 200
    finally:
        server.stop()
    assert not connection_file().exists()
