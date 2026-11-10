"""The WebView2 window on Windows: runtime check and event handlers."""

import sys
import types

import pytest

winreg = pytest.importorskip("winreg", reason="the WebView2 registry check exists only on Windows")

from gilzacode.window import webview2 as wv  # noqa: E402

NET_PATH = r"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full"
RUNTIME = wv.WEBVIEW2_CLIENT_KEYS[0]
BETA = wv.WEBVIEW2_CLIENT_KEYS[1]


def _registry(values):
    """A `read(hive, path, name)` over ``{(hive, path, name): value}``."""
    return lambda hive, path, name: values.get((hive, path, name))


def _machine_runtime(client, version):
    return (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{client}", "pv"), version


NET_OK = ((winreg.HKEY_LOCAL_MACHINE, NET_PATH, "Release"), 534296)


def test_a_machine_with_net_and_the_runtime_has_no_problem():
    read = _registry(dict([NET_OK, _machine_runtime(RUNTIME, "157.0.4341.42")]))
    assert wv.runtime_problem(read, machine="AMD64") == ""
    assert wv.installed_webview2_version(read, machine="AMD64") == "157.0.4341.42"


def test_a_per_user_runtime_counts():
    per_user = ((winreg.HKEY_CURRENT_USER, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{RUNTIME}", "pv"), "120.0.1.0")
    assert wv.runtime_problem(_registry(dict([NET_OK, per_user])), machine="AMD64") == ""


def test_a_preview_channel_counts_and_the_newest_version_wins():
    read = _registry(dict([NET_OK, _machine_runtime(RUNTIME, "100.0.0.0"), _machine_runtime(BETA, "158.0.1.2")]))
    assert wv.installed_webview2_version(read, machine="AMD64") == "158.0.1.2"


def test_32_bit_windows_reads_the_native_registry_view():
    native = ((winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{RUNTIME}", "pv"), "120.0.0.0")
    assert wv.runtime_problem(_registry(dict([NET_OK, native])), machine="x86") == ""


@pytest.mark.parametrize("version", [None, "0.0.0.0", "85.0.564.0", "garbage"])
def test_no_runtime_is_a_problem_that_names_the_download(version):
    values = dict([NET_OK])
    if version is not None:
        values.update([_machine_runtime(RUNTIME, version)])
    problem = wv.runtime_problem(_registry(values), machine="AMD64")
    assert "WebView2 Runtime was not found" in problem
    assert wv.WEBVIEW2_DOWNLOAD_URL in problem


@pytest.mark.parametrize("release", [None, 394801])
def test_an_old_net_framework_is_a_problem(release):
    values = dict([_machine_runtime(RUNTIME, "157.0.0.0")])
    if release is not None:
        values[(winreg.HKEY_LOCAL_MACHINE, NET_PATH, "Release")] = release
    assert ".NET Framework 4.6.2" in wv.runtime_problem(_registry(values), machine="AMD64")


def test_require_runtime_raises_instead_of_falling_back_to_mshtml(monkeypatch):
    monkeypatch.setattr(wv, "runtime_problem", lambda: "Microsoft Edge WebView2 Runtime was not found.")
    with pytest.raises(wv.WebView2Unavailable, match="WebView2 Runtime was not found"):
        wv.require_runtime()


def test_only_microphone_and_camera_are_granted():
    kinds = types.SimpleNamespace(Microphone="mic", Camera="cam", Geolocation="geo", ClipboardRead="clip")
    assert wv.permission_decision("mic", kinds)
    assert wv.permission_decision("cam", kinds)
    assert not wv.permission_decision("geo", kinds)
    assert not wv.permission_decision("clip", kinds)


class _Event(list):
    def __iadd__(self, handler):
        self.append(handler)
        return self


def _window(control):
    window = types.SimpleNamespace(native=types.SimpleNamespace(webview=control), events=types.SimpleNamespace())
    window.events.before_show = _Event()
    return window


def test_the_handlers_wait_for_webview2_to_initialise():
    WebView2 = type("WebView2", (), {})
    control = WebView2()
    control.CoreWebView2InitializationCompleted = _Event()
    window = _window(control)

    wv.install_handlers(window, log=lambda message: pytest.fail(message))
    assert len(window.events.before_show) == 1
    window.events.before_show[0](window)
    assert len(control.CoreWebView2InitializationCompleted) == 1


def test_a_window_that_is_not_webview2_is_reported():
    MSHTML = type("WebBrowserEx", (), {})
    logged = []
    window = _window(MSHTML())
    wv.install_handlers(window, log=logged.append)
    window.events.before_show[0](window)
    assert logged and "not a WebView2 control" in logged[0]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows only")
def test_this_machine_has_what_the_window_needs():
    """The acceptance machine for the WebView2 window (see PROJECT_DESIGN.md §2.16.1)."""
    assert wv.runtime_problem() == ""


# ── A dead browser process must not leave a silent grey window ──────────────

@pytest.mark.parametrize("kind,last,now,expected", [
    ("BrowserProcessExited", None, 0.0, wv.ASK_RESTART),
    ("RenderProcessExited", None, 0.0, wv.RELOAD),
    ("RenderProcessUnresponsive", None, 0.0, wv.RELOAD),
    ("RenderProcessExited", 100.0, 100.0 + wv.RELOAD_WINDOW_SECONDS - 1, wv.ASK_RESTART),
    ("RenderProcessExited", 100.0, 100.0 + wv.RELOAD_WINDOW_SECONDS + 1, wv.RELOAD),
    ("GpuProcessExited", None, 0.0, wv.IGNORE),
    ("FrameRenderProcessExited", None, 0.0, wv.IGNORE),
    ("UtilityProcessExited", None, 0.0, wv.IGNORE),
])
def test_failure_actions(kind, last, now, expected):
    assert wv.failure_action(kind, last, now) == expected


class _Kind:
    def __init__(self, name):
        self.name = name

    def ToString(self):
        return self.name


def _failure(name):
    return types.SimpleNamespace(ProcessFailedKind=_Kind(name))


def test_a_renderer_crash_reloads_once_then_asks_for_a_restart():
    reloads, shown, logged = [], [], []
    core = types.SimpleNamespace(Reload=lambda: reloads.append(1))
    clock = iter([10.0, 20.0, 200.0]).__next__
    restart = object()
    handler = wv.process_failed_handler(core, logged.append, restart, clock=clock,
                                        show=lambda kind, r, log: shown.append((kind, r)))

    handler(None, _failure("RenderProcessExited"))
    assert reloads == [1] and shown == []
    handler(None, _failure("RenderProcessExited"))  # 10 s later: a crash loop
    assert reloads == [1] and shown == [("RenderProcessExited", restart)]
    handler(None, _failure("RenderProcessExited"))  # long after: reload again
    assert reloads == [1, 1]
    assert all("browser process failure" in line for line in logged)


def test_the_browser_process_exiting_offers_the_restart():
    shown = []
    handler = wv.process_failed_handler(types.SimpleNamespace(Reload=lambda: pytest.fail("no reload")),
                                        lambda _m: None, None, clock=lambda: 0.0,
                                        show=lambda kind, r, log: shown.append((kind, r)))
    handler(None, _failure("BrowserProcessExited"))
    assert shown == [("BrowserProcessExited", None)]


class _Exception:
    def __init__(self, hresult):
        self.HResult = hresult


@pytest.mark.parametrize("hresult", [0x8007139F - 2**32, 0x8007139F])
def test_a_profile_held_by_another_window_is_told_apart(hresult):
    # .NET reports HResult as a signed 32-bit integer.
    assert wv.initialisation_failure_kind(_Exception(hresult)) == "profile_in_use"


@pytest.mark.parametrize("exception", [_Exception(-2147024891), _Exception(None), object(), None])
def test_other_initialisation_failures_keep_the_restart_dialog(exception):
    assert wv.initialisation_failure_kind(exception) == "other"
