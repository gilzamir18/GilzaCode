"""The desktop window: pywebview's WebView2 (``edgechromium``) backend.

Ported from GilzaBots (``windows_webview.py``, design §2.16.3). WebView2 ships
with Windows 11, so no Chromium is bundled. Three behaviours live here:

- **No silent MSHTML.** Without the WebView2 runtime (or .NET 4.6.2) pywebview's
  WinForms backend falls back to MSHTML, the Internet Explorer engine, with only
  a log warning. `runtime_problem` repeats pywebview's check before the window
  is created, and a missing runtime is a failure to open the window.
- **Permissions and full screen.** Microphone and camera are granted without a
  prompt, every other permission is denied, and an element asking for full
  screen (PDF presentation mode) puts the window in full screen. Both are
  WebView2 events subscribed through ``window.native``; pywebview is not patched.
- **No silent grey window.** When WebView2's browser or renderer process dies,
  pywebview leaves a grey window and only logs it. The page is reloaded once
  after a renderer failure; otherwise the user is told and offered a restart.

Everything that touches .NET is imported inside functions: pythonnet is only
loaded once pywebview has initialised it.
"""

from __future__ import annotations

import sys
from typing import Callable

#: Where the user gets the runtime (Microsoft's Evergreen bootstrapper page).
WEBVIEW2_DOWNLOAD_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

#: pywebview's thresholds (webview/platforms/winforms.py: _is_chromium).
MIN_NET_FRAMEWORK_RELEASE = 394802  # .NET Framework 4.6.2
MIN_WEBVIEW2_VERSION = (86, 0, 622, 0)

#: EdgeUpdate client ids of the WebView2 runtime and its preview channels.
WEBVIEW2_CLIENT_KEYS = (
    "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",  # Evergreen runtime
    "{2CD8A007-E189-409D-A2C8-9AF4EF3C72AA}",  # Beta
    "{0D50BFEC-CD6A-4F9A-964C-C7416E3ACB10}",  # Dev
    "{65C35B14-6C1D-4122-AC46-7148CC9D6497}",  # Canary
)


def _parse_version(text: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in str(text).strip().split("."))
    except ValueError:
        return ()


def _registry_value(hive, path: str, name: str):
    import winreg

    try:
        with winreg.OpenKey(hive, path) as key:
            return winreg.QueryValueEx(key, name)[0]
    except OSError:
        return None


def installed_webview2_version(read=_registry_value, machine: str | None = None) -> str:
    """The newest WebView2 version EdgeUpdate registered, or ``''``.

    Same keys pywebview reads: the per-user install under HKCU, the per-machine
    one under HKLM (in the 32-bit view on 64-bit Windows).
    """
    import platform
    import winreg

    machine = platform.machine() if machine is None else machine
    best = ""
    for client in WEBVIEW2_CLIENT_KEYS:
        locations = (
            (winreg.HKEY_CURRENT_USER, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{client}"),
            (winreg.HKEY_LOCAL_MACHINE,
             rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{client}" if machine.lower() == "x86"
             else rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{client}"),
        )
        for hive, path in locations:
            version = read(hive, path, "pv")
            if version and _parse_version(version) > _parse_version(best or "0"):
                best = str(version)
    return best


def runtime_problem(read=_registry_value, machine: str | None = None) -> str:
    """Why pywebview would not use WebView2 here, or ``''`` when it will."""
    import winreg

    release = read(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full", "Release")
    if not isinstance(release, int) or release < MIN_NET_FRAMEWORK_RELEASE:
        return ".NET Framework 4.6.2 or newer is required by the GilzaCode window and was not found."
    version = installed_webview2_version(read, machine)
    if _parse_version(version) < MIN_WEBVIEW2_VERSION:
        found = f" (found {version})" if version else ""
        return (
            f"Microsoft Edge WebView2 Runtime was not found{found}. "
            f"Install it from {WEBVIEW2_DOWNLOAD_URL} and start GilzaCode again."
        )
    return ""


class WebView2Unavailable(RuntimeError):
    """The window cannot be opened with WebView2 on this machine."""


def require_runtime() -> None:
    """Raise `WebView2Unavailable` instead of letting pywebview fall back to MSHTML."""
    problem = runtime_problem()
    if problem:
        raise WebView2Unavailable(problem)


def _log(message: str) -> None:
    print(f"[GilzaCode] WebView2: {message}", file=sys.stderr, flush=True)


def permission_decision(kind, kinds) -> bool:
    """Whether a WebView2 permission request of `kind` is granted.

    Microphone and camera (dictation, video capture) are granted without a
    prompt; everything else is denied.
    """
    return kind in (kinds.Microphone, kinds.Camera)


#: A page whose renderer fails again this soon after a reload is not reloaded again.
RELOAD_WINDOW_SECONDS = 60.0

#: Renderer failures of the page itself, which a reload recovers from.
_RENDERER_FAILURES = {"RenderProcessExited", "RenderProcessUnresponsive"}

IGNORE, RELOAD, ASK_RESTART = "ignore", "reload", "ask_restart"

FAILURE_TITLE = "GilzaCode window stopped"
FAILURE_BODY = ("The browser engine behind the GilzaCode window stopped ({reason}).\n\n"
                "Restart GilzaCode now? Unsaved changes in open editors may be lost.")
FAILURE_BODY_NO_RESTART = ("The browser engine behind the GilzaCode window stopped ({reason}).\n\n"
                           "Close GilzaCode and start it again.")


def failure_action(kind: str, last_reload: float | None, now: float) -> str:
    """What to do about a WebView2 ``ProcessFailed`` of `kind` (its enum name).

    A window whose browser processes died stays grey with no message, and the
    GilzaCode process behind it keeps running; that is what this is for.

    - The page's renderer exited or hung: reload it, once; a second failure
      within `RELOAD_WINDOW_SECONDS` is not retried in a loop but reported.
    - The browser process exited: the WebView2 control is dead and pywebview
      cannot create another, so only a restart brings the window back.
    - Anything else (the GPU process, which Chromium restarts itself; an
      iframe's renderer; utility processes) leaves the page usable: logged only.
    """
    if kind == "BrowserProcessExited":
        return ASK_RESTART
    if kind in _RENDERER_FAILURES:
        if last_reload is not None and now - last_reload < RELOAD_WINDOW_SECONDS:
            return ASK_RESTART
        return RELOAD
    return IGNORE


def _show_failure(kind: str, restart: Callable[[], object] | None, log: Callable[[str], None]) -> None:
    """Tell the user the window's browser is gone, and offer the restart."""
    import System.Windows.Forms as WinForms

    title = FAILURE_TITLE
    if restart is None:
        WinForms.MessageBox.Show(FAILURE_BODY_NO_RESTART.format(reason=kind), title,
                                 WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error)
        return
    answer = WinForms.MessageBox.Show(FAILURE_BODY.format(reason=kind), title,
                                      WinForms.MessageBoxButtons.YesNo, WinForms.MessageBoxIcon.Error)
    if answer == WinForms.DialogResult.Yes:
        log("restarting GilzaCode after the browser failure.")
        restart()


def process_failed_handler(core, log: Callable[[str], None], restart: Callable[[], object] | None,
                           clock: Callable[[], float] | None = None, show=_show_failure):
    """The ``ProcessFailed`` handler for `core` (a ``CoreWebView2``); see `failure_action`."""
    import time

    clock = clock or time.monotonic
    state = {"last_reload": None}

    def on_process_failed(_sender, args):
        try:
            kind = args.ProcessFailedKind.ToString()
        except Exception:
            kind = str(getattr(args, "ProcessFailedKind", "unknown"))
        now = clock()
        action = failure_action(kind, state["last_reload"], now)
        log(f"browser process failure: {kind} -> {action}")
        try:
            if action == RELOAD:
                state["last_reload"] = now
                core.Reload()
            elif action == ASK_RESTART:
                show(kind, restart, log)
        except Exception as exc:  # pragma: no cover - needs a live WebView2
            log(f"could not recover from {kind}: {type(exc).__name__}: {exc}")

    return on_process_failed


def install_handlers(window, log: Callable[[str], None] = _log,
                     restart: Callable[[], object] | None = None) -> None:
    """Subscribe the WebView2 events GilzaCode handles, for a pywebview `window`.

    Must be called before ``webview.start``. pywebview runs ``before_show``
    synchronously on the UI thread right after it created the form and asked
    WebView2 to initialise, so the initialisation event has not fired yet.
    `restart` relaunches the application; it is offered when the browser
    process is gone (`failure_action`).
    """

    def before_show(window):
        native = getattr(window, "native", None)
        control = getattr(native, "webview", None)
        if control is None or type(control).__name__ != "WebView2":
            # The runtime check passed, so this is not expected; say so rather
            # than run without the handlers and without a word.
            log(f"the window is not a WebView2 control ({type(control).__name__}); "
                "microphone permission and full screen will not be handled.")
            return

        def on_ready(sender, args):
            if not args.IsSuccess:
                # pywebview only logs this too, and the window stays grey.
                log(f"initialisation failed: {args.InitializationException}")
                try:
                    _show_failure(f"initialisation failed: {args.InitializationException}", restart, log)
                except Exception as exc:  # pragma: no cover - needs a live WebView2
                    log(f"could not report the failure: {type(exc).__name__}: {exc}")
                return
            try:
                from Microsoft.Web.WebView2.Core import CoreWebView2PermissionKind, CoreWebView2PermissionState

                core = sender.CoreWebView2

                def on_permission(_sender, request):
                    granted = permission_decision(request.PermissionKind, CoreWebView2PermissionKind)
                    request.State = (CoreWebView2PermissionState.Allow if granted
                                     else CoreWebView2PermissionState.Deny)

                def on_fullscreen(sender, _args):
                    wanted = bool(sender.ContainsFullScreenElement)
                    if wanted != bool(getattr(native, "is_fullscreen", False)):
                        native.toggle_fullscreen()

                core.PermissionRequested += on_permission
                core.ContainsFullScreenElementChanged += on_fullscreen
                core.ProcessFailed += process_failed_handler(core, log, restart)
            except Exception as exc:  # pragma: no cover - needs a live WebView2
                log(f"could not install the event handlers: {type(exc).__name__}: {exc}")

        control.CoreWebView2InitializationCompleted += on_ready

    window.events.before_show += before_show
