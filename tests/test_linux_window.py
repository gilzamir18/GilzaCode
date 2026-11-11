"""The Linux window (``window/qt.py``), its clipboard, and the Linux paths of the launcher and routes.

The policy functions are tested on every platform. What needs a real Qt runs
where PyQt6 is installed (Linux); scripts/smoke_linux_window.py opens the real
window, from source and from the installed bundle (release.yml).
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from types import SimpleNamespace

import pytest

from gilzacode import qt_clipboard
from gilzacode.window import qt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(autouse=True)
def fresh_qt_state(monkeypatch):
    monkeypatch.setattr(qt, "_APPLIED_OVER", {})
    monkeypatch.setattr(qt, "_dispatcher", None)


# ── Graphics environment ────────────────────────────────────────────────────

def test_the_gpu_is_off_by_default_through_both_renderers():
    env = {}
    report = qt.apply_environment(env)
    assert env == {qt.CHROMIUM_FLAGS_VAR: "--disable-gpu", qt.QUICK_BACKEND_VAR: "software"}
    assert report["gpu"] == "off"


def test_the_users_own_values_are_kept():
    env = {qt.CHROMIUM_FLAGS_VAR: "--lang=pt", qt.QUICK_BACKEND_VAR: "opengl"}
    qt.apply_environment(env)
    assert env == {qt.CHROMIUM_FLAGS_VAR: "--lang=pt --disable-gpu", qt.QUICK_BACKEND_VAR: "opengl"}


@pytest.mark.parametrize("value", ["0", "false", "off"])
def test_the_gpu_can_be_turned_on_for_a_run(value):
    env = {qt.DISABLE_GPU_VAR: value}
    assert qt.apply_environment(env)["gpu"] == "on"
    assert env == {qt.DISABLE_GPU_VAR: value}


def test_an_unknown_gpu_value_is_refused_not_guessed():
    with pytest.raises(ValueError, match="GILZACODE_DISABLE_GPU"):
        qt.apply_environment({qt.DISABLE_GPU_VAR: "maybe"})


def test_a_restart_gets_the_environment_from_before_this_run():
    """pywebview appends its own flags after ours; a restart must inherit neither."""
    env = {qt.CHROMIUM_FLAGS_VAR: "--lang=pt", "OTHER": "1"}
    qt.apply_environment(env)
    env[qt.CHROMIUM_FLAGS_VAR] += " --use-fake-ui-for-media-stream"
    assert qt.pristine_environment(env) == {qt.CHROMIUM_FLAGS_VAR: "--lang=pt", "OTHER": "1"}
    bare = {}
    qt.apply_environment(bare)
    assert qt.pristine_environment(bare) == {}


def test_root_is_refused_with_a_reason_unless_the_sandbox_was_turned_off():
    with pytest.raises(qt.QtUnavailable, match="root"):
        qt.require_runtime(env={}, euid=0)
    assert qt.sandbox_disabled({"QTWEBENGINE_DISABLE_SANDBOX": "1"})
    assert qt.sandbox_disabled({qt.CHROMIUM_FLAGS_VAR: "--disable-gpu --no-sandbox"})
    assert not qt.sandbox_disabled({qt.CHROMIUM_FLAGS_VAR: "--disable-gpu"})


def test_a_missing_qtwebengine_is_reported_instead_of_falling_back_to_gtk(monkeypatch):
    monkeypatch.setitem(sys.modules, "PyQt6.QtWebEngineWidgets", None)  # import fails
    with pytest.raises(qt.QtUnavailable, match="QtWebEngine"):
        qt.require_runtime(env={}, euid=1000)


# ── Handler policies ────────────────────────────────────────────────────────

def test_only_microphone_and_camera_are_granted():
    types = SimpleNamespace(MediaAudioCapture="mic", MediaVideoCapture="cam", MediaAudioVideoCapture="both")
    assert all(qt.permission_granted(kind, types) for kind in ("mic", "cam", "both"))
    assert not any(qt.permission_granted(kind, types) for kind in ("Geolocation", "Notifications", "ClipboardReadWrite"))


def _terminations(clock_values):
    statuses = SimpleNamespace(NormalTerminationStatus="normal")
    calls = []
    clock = iter(clock_values)
    handler = qt.renderer_terminated_handler(lambda: calls.append("reload"), lambda reason: calls.append(("ask", reason)),
                                             lambda _m: None, statuses, clock=lambda: next(clock))
    return handler, calls


def test_a_dead_renderer_is_reloaded_once_then_reported():
    handler, calls = _terminations([0.0, 10.0, 200.0])
    handler("crashed", 11)
    handler("crashed", 11)  # again within a minute: not reloaded in a loop
    handler("killed", 9)  # long after: reloaded again
    assert calls[0] == "reload" and calls[1][0] == "ask" and "exit code 11" in calls[1][1] and calls[2] == "reload"


def test_a_normal_termination_is_not_a_failure():
    handler, calls = _terminations([])
    handler("normal", 0)
    assert calls == []


@pytest.mark.parametrize("chosen, saved", [("/tmp/a", "/tmp/a.pdf"), ("/tmp/a.PDF", "/tmp/a.PDF")])
def test_a_print_is_saved_as_pdf(chosen, saved):
    assert qt.pdf_path_for(chosen) == saved


def test_the_window_size_policy_is_shared_with_windows():
    from gilzacode.launcher import size_for_screen
    assert size_for_screen(1920, 1080) == (1536, 864)
    assert size_for_screen(1000, 700) == (900, 600)


# ── UI thread and clipboard ─────────────────────────────────────────────────

def test_without_the_window_there_is_no_ui_thread():
    with pytest.raises(qt.WindowNotRunning):
        qt.run_on_ui_thread(lambda: 1)


def test_without_the_window_the_clipboard_says_so():
    with pytest.raises(qt_clipboard.ClipboardError, match="only in the GilzaCode window"):
        qt_clipboard.read_text()


def _pyqt6_available() -> bool:
    try:
        import PyQt6.QtWidgets  # noqa: F401
    except ImportError:
        return False
    return True


@pytest.mark.skipif(not sys.platform.startswith("linux") or not _pyqt6_available(), reason="needs PyQt6 on Linux")
def test_the_clipboard_round_trips_through_qt_from_another_thread():
    """A real QApplication (offscreen), the server's situation: calls come from a worker thread."""
    script = textwrap.dedent("""
        import threading, sys
        from PyQt6.QtCore import QTimer
        from PyQt6.QtGui import QImage, QColor
        from PyQt6.QtWidgets import QApplication
        from gilzacode import qt_clipboard
        from gilzacode.window import qt

        app = QApplication(sys.argv)
        qt._install_dispatcher()
        result = {}

        def worker():
            try:
                qt_clipboard.write_text("linha 1\\nação ✓")
                result["text"] = qt_clipboard.read_text()
                result["no_image"] = qt_clipboard.read_image_png_b64()
                image = QImage(3, 2, QImage.Format.Format_RGB32)
                image.fill(QColor("red"))
                qt.run_on_ui_thread(lambda: QApplication.clipboard().setImage(image))
                result["image"] = qt_clipboard.read_image_png_b64()
            except BaseException as exc:
                result["error"] = repr(exc)
            finally:
                QTimer.singleShot(0, app.quit)

        QTimer.singleShot(0, lambda: threading.Thread(target=worker).start())
        app.exec()
        print(repr(result))
    """)
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen", PYTHONPATH=ROOT)
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, env=env, timeout=60)
    assert out.returncode == 0, out.stderr
    result = eval(out.stdout.strip().splitlines()[-1])  # noqa: S307 - our own repr
    assert "error" not in result, result
    assert result["text"] == "linha 1\nação ✓"
    assert result["no_image"] == ""
    import base64
    import io

    from PIL import Image
    image = Image.open(io.BytesIO(base64.b64decode(result["image"])))
    assert (image.format, image.size) == ("PNG", (3, 2))


async def test_the_clipboard_endpoints_use_qt_on_linux(client, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(qt_clipboard, "read_text", lambda: "from qt")
    assert (await (await client.get("/api/clipboard/read")).json()) == {"text": "from qt"}


async def test_without_the_window_a_clipboard_request_says_why(client, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    response = await client.get("/api/clipboard/read")
    assert response.status == 500
    assert "only in the GilzaCode window" in (await response.json())["error"]


# ── Launcher ────────────────────────────────────────────────────────────────

def _capture_popen(monkeypatch):
    from gilzacode import launcher
    calls = []
    monkeypatch.setattr(launcher.subprocess, "Popen", lambda command, **kwargs: calls.append((command, kwargs)))
    return launcher, calls


def test_a_linux_restart_starts_a_new_session_without_this_runs_flags(monkeypatch):
    launcher, calls = _capture_popen(monkeypatch)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv(qt.CHROMIUM_FLAGS_VAR, raising=False)
    monkeypatch.delenv(qt.QUICK_BACKEND_VAR, raising=False)
    qt.apply_environment()
    try:
        launcher.spawn_detached(["GilzaCode"])
    finally:
        os.environ.pop(qt.CHROMIUM_FLAGS_VAR, None)
        os.environ.pop(qt.QUICK_BACKEND_VAR, None)
    (_command, kwargs), = calls
    assert kwargs["start_new_session"] is True
    assert qt.CHROMIUM_FLAGS_VAR not in kwargs["env"] and qt.QUICK_BACKEND_VAR not in kwargs["env"]


def test_a_windows_restart_is_unchanged(monkeypatch):
    launcher, calls = _capture_popen(monkeypatch)
    monkeypatch.setattr(sys, "platform", "win32")
    launcher.spawn_detached(["GilzaCode.exe"])
    (_command, kwargs), = calls
    assert kwargs == {"close_fds": True, "cwd": os.getcwd(), "creationflags": 0x00000008}


def test_the_linux_window_is_qt_and_other_systems_are_refused(monkeypatch):
    from gilzacode import launcher
    opened = []
    monkeypatch.setattr(launcher, "BackgroundServer", lambda *a: SimpleNamespace(start=lambda: None, stop=lambda: None,
                                                                                 url="http://127.0.0.1:1"))
    monkeypatch.setattr(launcher, "_run_qt_window", lambda server: opened.append("qt") or 0)
    monkeypatch.setattr(sys, "platform", "linux")
    assert launcher.run(port=1) == 0 and opened == ["qt"]
    monkeypatch.setattr(sys, "platform", "darwin")
    with pytest.raises(SystemExit, match="Windows and Linux only"):
        launcher.run(port=1)


def test_the_linux_window_has_an_icon():
    from gilzacode.launcher import window_icon
    assert window_icon() and window_icon().endswith("GilzaCode.png")


# ── Frozen-build environment ────────────────────────────────────────────────

BUNDLE = "/opt/GilzaCode/_internal"


def _host(env, **overrides):
    from gilzacode.subprocess_utils import host_environment
    options = dict(frozen=True, platform="linux", bundle=BUNDLE)
    options.update(overrides)
    return host_environment(env, **options)


def test_started_programs_get_the_users_library_path_back():
    assert _host({"LD_LIBRARY_PATH": f"{BUNDLE}:/opt/mine", "LD_LIBRARY_PATH_ORIG": "/opt/mine", "A": "1"}) == {
        "LD_LIBRARY_PATH": "/opt/mine", "A": "1"}
    assert _host({"LD_LIBRARY_PATH": BUNDLE}) == {}


def test_the_users_library_path_survives_a_second_pass():
    once = _host({"LD_LIBRARY_PATH": f"{BUNDLE}:/opt/mine", "LD_LIBRARY_PATH_ORIG": "/opt/mine"})
    assert _host(once) == {"LD_LIBRARY_PATH": "/opt/mine"}


def test_the_environment_is_only_copied_outside_a_packaged_linux_build():
    env = {"LD_LIBRARY_PATH": f"{BUNDLE}:/opt/mine", "LD_LIBRARY_PATH_ORIG": "/opt/mine"}
    assert _host(env, frozen=False) == env
    assert _host(env, platform="win32") == env
    copy = _host(env, frozen=False)
    copy["X"] = "1"
    assert "X" not in env


def test_every_started_program_gets_an_explicit_environment():
    """A spawn without ``env=`` would inherit a packaged build's library path.

    The one exception is the Windows restart, which is unchanged.
    """
    import ast
    package = os.path.join(ROOT, "gilzacode")
    spawn_attributes = {"run", "Popen", "create_subprocess_exec"}  # subprocess.X / asyncio.X
    spawn_names = {"Popen", "popen"}  # an imported Popen, or an injected one
    missing = set()
    for folder, _dirs, files in os.walk(package):
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(folder, name)
            tree = ast.parse(open(path, encoding="utf-8").read())
            for function in ast.walk(tree):
                if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                for call in ast.walk(function):
                    if not isinstance(call, ast.Call) or any(keyword.arg == "env" for keyword in call.keywords):
                        continue
                    func = call.func
                    spawn = (isinstance(func, ast.Attribute) and func.attr in spawn_attributes
                             and isinstance(func.value, ast.Name) and func.value.id in {"subprocess", "asyncio"}) or (
                             isinstance(func, ast.Name) and func.id in spawn_names)
                    if spawn:
                        missing.add((os.path.relpath(path, package).replace(os.sep, "/"), function.name))
    assert missing == {("launcher.py", "spawn_detached")}


# ── Claude Code on Linux ────────────────────────────────────────────────────

def test_claude_is_found_where_its_installer_puts_it_when_path_does_not_say(monkeypatch, tmp_path):
    from gilzacode import claude_cli
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("GILZACODE_CLAUDE", raising=False)
    monkeypatch.setattr(claude_cli.shutil, "which", lambda _name: None)
    with pytest.raises(claude_cli.ClaudeCliError):
        claude_cli.find_claude()
    claude = tmp_path / ".local" / "bin" / "claude"
    claude.parent.mkdir(parents=True)
    claude.write_text("#!/bin/sh\n")
    claude.chmod(0o755)
    if os.name == "nt":
        pytest.skip("the executable bit does not exist on Windows")
    assert claude_cli.find_claude() == str(claude)


def test_windows_searches_only_path_for_claude(monkeypatch):
    from gilzacode import claude_cli
    monkeypatch.setattr(sys, "platform", "win32")
    assert claude_cli.installer_locations() == []


# ── Tectonic and xdg-open ───────────────────────────────────────────────────

def test_tectonic_downloads_per_platform():
    from gilzacode.server import routes_latex
    assert routes_latex.tectonic_download("win32", "AMD64") == (routes_latex.TECTONIC_URL_WINDOWS, "tectonic.zip")
    url, name = routes_latex.tectonic_download("linux", "x86_64")
    assert url.endswith("x86_64-unknown-linux-musl.tar.gz") and name == "tectonic.tar.gz"
    for platform, machine in (("linux", "aarch64"), ("darwin", "arm64")):
        with pytest.raises(ValueError):
            routes_latex.tectonic_download(platform, machine)


class _Launched:
    def __init__(self, code=None, stderr=b""):
        self.code = code
        self.stderr = SimpleNamespace(read=lambda: stderr)

    def wait(self, timeout):
        if self.code is None:
            raise subprocess.TimeoutExpired("xdg-open", timeout)
        return self.code


def test_xdg_open_is_watched_for_an_early_failure():
    from gilzacode.desktop import open_with_desktop
    launched = []

    def popen(argv, **kwargs):
        launched.append((argv, kwargs))
        return _Launched(code=None)

    open_with_desktop("/p/file.pdf", popen=popen)
    (argv, kwargs), = launched
    assert argv == ["xdg-open", "/p/file.pdf"] and kwargs["start_new_session"] is True and "env" in kwargs
    open_with_desktop("/p", popen=lambda *a, **k: _Launched(code=0))
    with pytest.raises(OSError, match="exit status 4.*no handler"):
        open_with_desktop("/p", popen=lambda *a, **k: _Launched(code=4, stderr=b"no handler"))

    def missing(*_a, **_k):
        raise FileNotFoundError("xdg-open")

    with pytest.raises(OSError, match="xdg-utils"):
        open_with_desktop("/p", popen=missing)


def test_a_link_that_cannot_be_opened_is_reported_as_not_opened(monkeypatch):
    from gilzacode import desktop

    def fail(_target):
        raise OSError("no browser")

    monkeypatch.setattr(desktop, "open_with_desktop", fail)
    assert desktop.open_url("https://example.com") is False


def test_oauth_opens_the_browser_through_the_desktop_on_linux(monkeypatch):
    from gilzacode import desktop
    from gilzacode.cloud import oauth
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr("webbrowser.open", lambda *a, **k: pytest.fail("webbrowser must not be used on Linux"))
    opened = []
    monkeypatch.setattr(desktop, "open_url", lambda url: opened.append(url) or True)
    assert oauth.open_in_browser("https://accounts.google.com/x") is True and opened == ["https://accounts.google.com/x"]


async def test_the_open_endpoint_uses_the_desktop_on_linux(client, project, monkeypatch):
    from gilzacode import desktop
    opened = []
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(desktop, "open_with_desktop", opened.append)
    response = await client.post("/api/file/open-explorer", json={"projectPath": str(project)})
    assert response.status == 200 and opened == [os.path.abspath(str(project))]


# ── Dependencies ────────────────────────────────────────────────────────────

def _dependencies(platform: str) -> set[str]:
    import tomllib

    from packaging.requirements import Requirement
    with open(os.path.join(ROOT, "pyproject.toml"), "rb") as handle:
        lines = tomllib.load(handle)["project"]["dependencies"]
    names = set()
    for line in lines:
        req = Requirement(line)
        if req.marker is None or req.marker.evaluate({"sys_platform": platform, "platform_system": ""}):
            names.add(req.name.lower())
    return names


def test_windows_installs_no_qt_and_linux_installs_no_winpty():
    windows, linux = _dependencies("win32"), _dependencies("linux")
    assert not {name for name in windows if "qt" in name}
    assert {"pywebview", "pywinpty"} <= windows
    assert {"pywebview", "pyqt6", "pyqt6-qt6", "pyqt6-webengine", "pyqt6-webengine-qt6", "qtpy"} <= linux
    assert "pywinpty" not in linux


def test_the_qt_gate_reads_the_linux_floors():
    import importlib.util
    spec = importlib.util.spec_from_file_location("check_qt_runtime", os.path.join(ROOT, "scripts", "check_qt_runtime.py"))
    gate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gate)
    floors = {name: str(version) for name, version in gate.qt_floors().items()}
    assert floors == {"pyqt6": "6.11.0", "pyqt6-qt6": "6.11.2", "pyqt6-webengine": "6.11.0", "pyqt6-webengine-qt6": "6.11.2"}
    mixed = {"pyqt6": "6.12.0", "pyqt6-qt6": "6.12.0", "pyqt6-webengine": "6.11.0", "pyqt6-webengine-qt6": "6.11.2"}
    assert "different Qt releases" in gate.mixed_release_problem(installed=mixed.__getitem__)
    same = dict(mixed, pyqt6="6.11.1", **{"pyqt6-qt6": "6.11.2"})
    assert gate.mixed_release_problem(installed=same.__getitem__) is None
