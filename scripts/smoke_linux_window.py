#!/usr/bin/env python3
"""Open the real GilzaCode window on Linux and check it through the DevTools protocol.

    python3 scripts/smoke_linux_window.py <command...> [--screenshot out.png]

`command` starts GilzaCode: an installed bundle (``~/.local/share/GilzaCode/
GilzaCode/GilzaCode``) or a source run (``python -m gilzacode``). It needs a
display (X11, Wayland, or ``xvfb-run``). The window is started with
QtWebEngine's remote debugging on a free port, and the page it shows is asked:

- the interface rendered (React mounted into ``#root``);
- the clipboard round-trips through ``/api/clipboard/*`` (the Qt clipboard);
- ``requestFullscreen`` is accepted (presentation mode);
- a permission other than microphone and camera (geolocation) is denied;
- a shell in the integrated terminal runs and sees the user's own
  ``LD_LIBRARY_PATH``, not the bundle's (``restore_host_library_path``);
- the browser profile was written to ``GILZACODE_HOME/webview``, not ``~/.pywebview``.

Standard library only, and Python 3.10 compatible: release.yml runs it on the
system Python of every supported Ubuntu, against the installed bundle.
Exit status 0 when every check passes.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

SERVING = re.compile(r"\[GilzaCode\] serving (http://127\.0\.0\.1:\d+)")


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class DevTools:
    """A minimal WebSocket client for one DevTools page target."""

    def __init__(self, ws_url: str):
        host_port, path = ws_url[len("ws://"):].split("/", 1)
        host, port = host_port.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("DevTools closed the WebSocket handshake")
            response += chunk
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"DevTools refused the WebSocket: {response[:200]!r}")
        self.buffer = response.split(b"\r\n\r\n", 1)[1]
        self.next_id = 0

    def _read(self, n: int) -> bytes:
        while len(self.buffer) < n:
            chunk = self.sock.recv(1 << 16)
            if not chunk:
                raise RuntimeError("DevTools closed the connection")
            self.buffer += chunk
        data, self.buffer = self.buffer[:n], self.buffer[n:]
        return data

    def _frame(self) -> tuple[int, bool, bytes]:
        first, second = self._read(2)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read(8))[0]
        return first & 0x0F, bool(first & 0x80), self._read(length)

    def _message(self) -> dict:
        payload = b""
        while True:
            opcode, final, data = self._frame()
            if opcode == 8:
                raise RuntimeError("DevTools closed the connection")
            if opcode in (0, 1):
                payload += data
                if final:
                    return json.loads(payload.decode("utf-8"))

    def call(self, method: str, **params) -> dict:
        self.next_id += 1
        body = json.dumps({"id": self.next_id, "method": method, "params": params}).encode()
        mask = os.urandom(4)
        header = bytes([0x81])
        if len(body) < 126:
            header += bytes([0x80 | len(body)])
        elif len(body) < 1 << 16:
            header += bytes([0x80 | 126]) + struct.pack(">H", len(body))
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", len(body))
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(body)))
        while True:
            message = self._message()
            if message.get("id") == self.next_id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})

    def evaluate(self, expression: str):
        # The target is listed as soon as its navigation starts, so the first
        # evaluation can land on the document being replaced. A renderer that
        # died is caught separately, from the application's own log.
        for attempt in range(10):
            try:
                result = self.call("Runtime.evaluate", expression=expression, awaitPromise=True,
                                   returnByValue=True, userGesture=True)
                break
            except RuntimeError as exc:
                if "Execution context was destroyed" not in str(exc) or attempt == 9:
                    raise
                time.sleep(0.5)
        if "exceptionDetails" in result:
            raise RuntimeError(json.dumps(result["exceptionDetails"])[:500])
        return result["result"].get("value")


def wait_for_page(debug_port: int, server_url: str, deadline: float) -> str:
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/list", timeout=2) as response:
                for target in json.load(response):
                    if target.get("type") == "page" and target.get("url", "").startswith(server_url):
                        return target["webSocketDebuggerUrl"]
        except OSError:
            pass
        time.sleep(0.5)
    raise RuntimeError("the window never showed the GilzaCode page")


CHECKS = {
    "the interface rendered": """
        (async () => {
          for (let i = 0; i < 120; i++) {
            const root = document.querySelector('#root');
            if (document.readyState === 'complete' && root && root.querySelector('.vscode-app')) return true;
            await new Promise(r => setTimeout(r, 250));
          }
          return document.querySelector('#root')?.innerHTML.slice(0, 300) || 'empty #root';
        })()""",
    "the clipboard round-trips": """
        (async () => {
          const text = 'gilzacode smoke ✓ ' + Date.now();
          const w = await (await fetch('/api/clipboard/write', {method: 'POST',
            headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text})})).json();
          if (!w.ok) return 'write: ' + JSON.stringify(w);
          const r = await (await fetch('/api/clipboard/read')).json();
          return r.text === text ? true : 'read back ' + JSON.stringify(r);
        })()""",
    "full screen is accepted": """
        (async () => {
          try { await document.documentElement.requestFullscreen(); }
          catch (e) { return 'refused: ' + e; }
          const ok = !!document.fullscreenElement;
          await document.exitFullscreen();
          return ok || 'no fullscreen element';
        })()""",
    "geolocation is denied": """
        new Promise(resolve => navigator.geolocation.getCurrentPosition(
          () => resolve('granted'), e => resolve(e.code === e.PERMISSION_DENIED || 'error ' + e.code),
          {timeout: 10000}))""",
}

TERMINAL_CHECK = """
    (async (project) => {
      const q = new URLSearchParams({term_id: 'main-1', projectPath: project});
      const stream = new EventSource('/api/terminal/stream?' + q);
      await new Promise(r => setTimeout(r, 1500));
      await fetch('/api/terminal/input', {method: 'POST', headers: {'Content-Type': 'application/json'},
        // The quotes split the marker in the echoed command line, so only the output matches.
        body: JSON.stringify({term_id: 'main-1', projectPath: project, text: 'echo "LD=[${LD_LIBRARY_PATH}]""END"\\r'})});
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 250));
        const out = await (await fetch('/api/terminal/output?' + q)).json();
        const match = /LD=\\[([^\\]\\n]*)\\]END/.exec(out.text || '');
        if (match) { stream.close(); return match[1]; }
      }
      stream.close();
      return null;
    })(%s)"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    parser.add_argument("--screenshot", default="")
    parser.add_argument("--timeout", type=float, default=120.0)
    args, rest = parser.parse_known_args(argv)
    command = [part for part in (args.command or rest) if part != "--"]
    if not command:
        parser.error("give the command that starts GilzaCode")

    home = tempfile.mkdtemp(prefix="gilzacode-smoke-")
    project = os.path.join(home, "project")
    os.makedirs(project)
    debug_port = free_port()
    # A library path of the user's own: a packaged build must hand exactly this
    # to the terminal's shell, with the bundle's folder taken back out.
    expected_ld = "/opt/gilzacode-smoke-user-libs"
    env = dict(os.environ, GILZACODE_HOME=os.path.join(home, "data"), QTWEBENGINE_REMOTE_DEBUGGING=str(debug_port),
               LD_LIBRARY_PATH=expected_ld)
    had_stray = os.path.exists(os.path.expanduser("~/.pywebview"))
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, errors="replace", start_new_session=True)
    log: list[str] = []
    server = {}
    ready = threading.Event()

    def pump():
        for line in process.stdout:
            log.append(line.rstrip("\n"))
            match = SERVING.search(line)
            if match and not ready.is_set():
                server["url"] = match.group(1)
                ready.set()

    threading.Thread(target=pump, daemon=True).start()
    failures = []
    try:
        if not ready.wait(args.timeout):
            raise RuntimeError("GilzaCode never said where it serves")
        devtools = DevTools(wait_for_page(debug_port, server["url"], time.time() + args.timeout))
        for name, expression in CHECKS.items():
            value = devtools.evaluate(expression)
            print(f"[{'PASS' if value is True else 'FAIL'}] {name}" + ("" if value is True else f": {value}"))
            if value is not True:
                failures.append(name)
        seen = devtools.evaluate(TERMINAL_CHECK % json.dumps(project))
        ok = seen == expected_ld
        print(f"[{'PASS' if ok else 'FAIL'}] the terminal's shell sees the user's LD_LIBRARY_PATH "
              f"({seen!r}, expected {expected_ld!r})")
        if not ok:
            failures.append("terminal LD_LIBRARY_PATH")
        if args.screenshot:
            shot = devtools.call("Page.captureScreenshot", format="png")
            with open(args.screenshot, "wb") as out:
                out.write(base64.b64decode(shot["data"]))
            print(f"screenshot: {args.screenshot}")
    except Exception as exc:  # report, then show the application's own output
        failures.append(f"{type(exc).__name__}: {exc}")
        print(f"[FAIL] {type(exc).__name__}: {exc}")
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=15)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        profile = os.path.join(home, "data", "webview")
        stray = os.path.expanduser("~/.pywebview")
        ok = os.path.isdir(profile) and bool(os.listdir(profile)) and (had_stray or not os.path.exists(stray))
        print(f"[{'PASS' if ok else 'FAIL'}] the browser profile is in GILZACODE_HOME/webview, not ~/.pywebview")
        if not ok:
            failures.append("browser profile location")
        crashes = [line for line in log if "renderer terminated" in line]
        print(f"[{'FAIL' if crashes else 'PASS'}] no renderer died" + (f": {crashes}" if crashes else ""))
        if crashes:
            failures.append("renderer died")
        if failures:
            print("---- GilzaCode output ----")
            print("\n".join(log[-80:]))
        shutil.rmtree(home, ignore_errors=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
