"""Start the loopback server and open the desktop window."""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

from aiohttp import web

from gilzacode.paths import gilzacode_home
from gilzacode.server.app import create_app, default_static_dir
from gilzacode.session import LocalSession, remove_connection_file, write_connection_file

DEFAULT_PORT = 3100
MAX_PORT = 3150
WINDOW_BACKGROUND = "#0f1117"


def find_available_port(host: str, start: int = DEFAULT_PORT, end: int = MAX_PORT) -> int:
    """The first port in [start, end] the listener can bind.

    No SO_REUSEADDR: on Windows it would let the probe bind a port another
    process is already listening on.
    """
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port between {start} and {end}.")


class BackgroundServer:
    """The aiohttp application on its own event loop in a daemon thread.

    The main thread belongs to the window toolkit (pywebview requires it).
    """

    def __init__(self, host: str, port: int, static_dir: Path | None):
        self.host, self.port = host, port
        self.session = LocalSession(host, port)
        self.app = create_app(self.session, static_dir)
        self._ready = threading.Event()
        self._failure: BaseException | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._runner: web.AppRunner | None = None
        self._thread = threading.Thread(target=self._run, name="gilzacode-server", daemon=True)

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._runner = web.AppRunner(self.app, access_log=None)
            self._loop.run_until_complete(self._runner.setup())
            site = web.TCPSite(self._runner, self.host, self.port)
            self._loop.run_until_complete(site.start())
        except BaseException as exc:  # reported to the caller of start()
            self._failure = exc
            self._ready.set()
            return
        self._ready.set()
        self._loop.run_forever()

    def start(self, timeout: float = 10.0) -> None:
        self._thread.start()
        if not self._ready.wait(timeout):
            raise RuntimeError("The local server did not start in time.")
        if self._failure is not None:
            raise RuntimeError(f"The local server failed to start: {self._failure}") from self._failure
        write_connection_file(self.session)

    def stop(self) -> None:
        remove_connection_file(self.session)
        if self._loop is None or self._runner is None:
            return
        future = asyncio.run_coroutine_threadsafe(self._runner.cleanup(), self._loop)
        try:
            future.result(timeout=5)
        except Exception:
            pass
        self._loop.call_soon_threadsafe(self._loop.stop)


def relaunch_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, *sys.argv[1:]]
    return [sys.executable, "-m", "gilzacode", *sys.argv[1:]]


def spawn_detached(command: list[str]) -> subprocess.Popen:
    """Start `command` detached from this process.

    DETACHED_PROCESS keeps the child alive after this process exits. Never add
    CREATE_NEW_PROCESS_GROUP: Windows then disables Ctrl+C in the new process (an
    implicit ``SetConsoleCtrlHandler(NULL, TRUE)``) and every process it starts
    inherits that, so after a restart Ctrl+C would stop working in the integrated
    terminal, and in Claude Code running there (found in GilzaBots).
    """
    return subprocess.Popen(command, close_fds=True, cwd=os.getcwd(),
                            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0x00000008))


def schedule_restart(delay: float = 0.3) -> None:
    """Start a new GilzaCode detached from this one, then end this process."""
    spawn_detached(relaunch_command())

    def _exit():
        time.sleep(delay)
        os._exit(0)

    threading.Thread(target=_exit, daemon=True).start()


def _window_size(webview) -> tuple[int, int]:
    try:
        primary = webview.screens[0]
        return max(900, int(primary.width * 0.8)), max(600, int(primary.height * 0.8))
    except Exception:
        return 1280, 800


def run(host: str = "127.0.0.1", port: int | None = None, *, browser: bool = False) -> int:
    """Serve the interface and open it; returns when the window closes."""
    port = port or find_available_port(host)
    server = BackgroundServer(host, port, default_static_dir())
    server.start()
    print(f"[GilzaCode] serving {server.url}", flush=True)
    try:
        if browser:
            import webbrowser
            webbrowser.open(server.url)
            threading.Event().wait()
            return 0
        if sys.platform != "win32":
            raise SystemExit("The GilzaCode window is implemented for Windows only; use --browser.")
        from gilzacode.window import webview2

        # A missing runtime would silently give MSHTML (the IE engine).
        webview2.require_runtime()
        import webview

        webview.settings["ALLOW_DOWNLOADS"] = True
        width, height = _window_size(webview)
        window = webview.create_window(
            title="GilzaCode", url=server.url, width=width, height=height,
            resizable=True, text_select=True, zoomable=True, background_color=WINDOW_BACKGROUND,
        )
        storage = gilzacode_home() / "webview"
        webview2.install_handlers(window, restart=lambda: schedule_restart(0.2), profile_folder=str(storage))
        storage.mkdir(parents=True, exist_ok=True)
        webview.start(gui="edgechromium", debug=bool(os.environ.get("GILZACODE_DEVTOOLS")),
                      private_mode=False, storage_path=str(storage))
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        log = gilzacode_home() / "window_error.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(traceback.format_exc(), encoding="utf-8")
        print(f"[GilzaCode] the window could not be opened: {exc}\n(details in {log})", file=sys.stderr)
        return 1
    finally:
        server.stop()
