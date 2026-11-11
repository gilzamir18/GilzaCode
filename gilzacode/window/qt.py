"""The desktop window on Linux: pywebview's Qt backend with QtWebEngine.

Adapted from GilzaBots, whose window is QtWebEngine on Linux (``ide_server.
start_gui_server`` and ``webengine_env.py``, design §2.16.1). Windows is
unaffected: it keeps WebView2 (``webview2.py``) and never imports this module.

GilzaBots monkey-patched pywebview's Qt classes before ``webview.start``. Here,
as in ``webview2.py``, nothing in pywebview is patched: pywebview runs
``before_show`` synchronously on the UI thread at the end of its
``BrowserView.__init__``, after the page and its profile exist and before the
window is shown, and the handlers are connected there through
``window.native``. That also keeps the browser profile in
``<gilzacode home>/webview``: pywebview's Qt module computes its profile path
when it is imported, and GilzaBots' patches imported it before
``webview.start(storage_path=...)``, so its Qt profile went to ``~/.pywebview``.

What is handled:

- **Permissions.** Microphone and camera are granted without a prompt and
  every other permission is denied (Qt 6.8+ ``permissionRequested``).
  pywebview's own handler calls the deprecated ``setFeaturePermission`` with
  plain integers, which PyQt6 refuses, so it is disconnected.
- **Full screen.** An element asking for full screen (PDF presentation mode)
  puts the window in full screen, and leaving it restores the window.
  QtWebEngine refuses ``requestFullscreen`` unless the page enables it and
  someone accepts the request.
- **Printing.** ``window.print()`` asks where to save a PDF and prints the page
  into it, as in GilzaBots: an embedded QtWebEngine has no print dialog.
- **Downloads** are saved where the user chooses, starting in Downloads.
  pywebview's handler uses a Qt 5 API (``setPath``).
- **A renderer that dies** is reloaded once; a second failure within a minute
  is reported with an offer to restart, the policy of ``webview2.py``.

The graphics environment (`apply_environment`) is GilzaBots' Linux default:
QtWebEngine runs its GPU service inside this process, so a driver fault takes
the application down with no Python traceback, and Mesa's Zink/EGL layer can
abort at startup without a DRM render node. Acceleration is therefore off
unless ``GILZACODE_DISABLE_GPU=0`` asks for it.

Everything that touches Qt is imported inside functions: this module is also
imported by the tests and by the clipboard routes, which must not load Qt.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Callable, Mapping, MutableMapping

from gilzacode.window.webview2 import (
    ASK_RESTART,
    FAILURE_BODY,
    FAILURE_BODY_NO_RESTART,
    FAILURE_TITLE,
    RELOAD,
    failure_action,
)

# ── Graphics environment ────────────────────────────────────────────────────

#: QtWebEngine reads its Chromium flags from this variable, once, before the browser exists.
CHROMIUM_FLAGS_VAR = "QTWEBENGINE_CHROMIUM_FLAGS"
#: Qt's scene graph, which composites the web view into the window.
QUICK_BACKEND_VAR = "QT_QUICK_BACKEND"
QUICK_BACKEND_SOFTWARE = "software"
DISABLE_GPU_VAR = "GILZACODE_DISABLE_GPU"
DISABLE_GPU_FLAG = "--disable-gpu"

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}

#: What the variables `apply_environment` writes held before it wrote them.
_APPLIED_OVER: dict[str, str | None] = {}


def gpu_disabled(env: Mapping[str, str]) -> bool:
    """Whether this run keeps the GPU out of the process (the default)."""
    raw = str(env.get(DISABLE_GPU_VAR, "")).strip().lower()
    if raw == "" or raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    raise ValueError(f"{DISABLE_GPU_VAR}={env.get(DISABLE_GPU_VAR)!r} is not understood; "
                     "use 1 (GPU off, the default) or 0 (GPU on).")


def _append_flag(flags: str, flag: str) -> str:
    return flags if flag in flags.split() else f"{flags} {flag}".strip()


def apply_environment(env: MutableMapping[str, str] | None = None) -> dict:
    """Set QtWebEngine's graphics variables for this process; report what was decided.

    A user's own values are kept: the flag is appended to any flags already
    there, and a ``QT_QUICK_BACKEND`` set by hand is left alone. Turning the GPU
    off needs both: ``--disable-gpu`` stops Chromium from using it, but Qt
    composites the view through its own scene graph, which still loads the
    driver (measured in GilzaBots).
    """
    env = os.environ if env is None else env
    off = gpu_disabled(env)
    flags_before, quick_before = env.get(CHROMIUM_FLAGS_VAR), env.get(QUICK_BACKEND_VAR)
    _APPLIED_OVER.clear()
    _APPLIED_OVER[CHROMIUM_FLAGS_VAR] = flags_before
    _APPLIED_OVER[QUICK_BACKEND_VAR] = quick_before
    if off:
        env[CHROMIUM_FLAGS_VAR] = _append_flag(flags_before or "", DISABLE_GPU_FLAG)
        if not quick_before:
            env[QUICK_BACKEND_VAR] = QUICK_BACKEND_SOFTWARE
    return {
        "gpu": "off" if off else "on",
        "chromium_flags": env.get(CHROMIUM_FLAGS_VAR, ""),
        "qt_quick_backend": env.get(QUICK_BACKEND_VAR, ""),
    }


def pristine_environment(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """A copy of `env` with this run's graphics variables put back as they were.

    A restarted GilzaCode is a child of the process it replaces. It would
    otherwise inherit the flags this run wrote, and the ones pywebview appends
    after them (``--use-fake-ui-for-media-stream`` ...), one more copy per
    restart. Values the user exported are restored, not deleted.
    """
    fresh = dict(os.environ if env is None else env)
    for name, original in _APPLIED_OVER.items():
        if original is None:
            fresh.pop(name, None)
        else:
            fresh[name] = original
    return fresh


class QtUnavailable(RuntimeError):
    """The window cannot be opened with QtWebEngine in this environment."""


def sandbox_disabled(env: Mapping[str, str]) -> bool:
    """Whether the user turned Chromium's sandbox off with QtWebEngine's own switches."""
    return env.get("QTWEBENGINE_DISABLE_SANDBOX") == "1" or "--no-sandbox" in env.get(CHROMIUM_FLAGS_VAR, "").split()


def require_runtime(env: Mapping[str, str] | None = None, euid: int | None = None) -> None:
    """Raise `QtUnavailable` when the window cannot open, instead of a worse failure.

    - Asked for ``gui="qt"``, pywebview still tries GTK when the Qt import
      fails, and GTK means WebKitGTK, an engine the interface is not built for.
    - As root, Chromium aborts its zygote ("Running as root without
      --no-sandbox is not supported") and the window never appears.
    """
    env = os.environ if env is None else env
    euid = (os.geteuid() if hasattr(os, "geteuid") else None) if euid is None else euid
    if euid == 0 and not sandbox_disabled(env):
        raise QtUnavailable("The GilzaCode window cannot run as root: its browser engine (Chromium) refuses to "
                            "start without its sandbox. Start GilzaCode as your own user.")
    missing = []
    for module in ("PyQt6.QtWebEngineWidgets", "qtpy"):
        try:
            __import__(module)
        except ImportError as exc:
            missing.append(f"{module} ({exc})")
    if missing:
        raise QtUnavailable("The GilzaCode window needs QtWebEngine, which could not be loaded: "
                            + "; ".join(missing) + ". A system library named there is missing, "
                            "or the installation is incomplete.")


# ── Running code on the UI thread ───────────────────────────────────────────

class WindowNotRunning(OSError):
    """There is no Qt window in this process to do the work."""


_dispatcher = None


def _install_dispatcher() -> None:
    """Create the object that runs jobs on the UI thread. Call it on that thread."""
    global _dispatcher
    if _dispatcher is not None:
        return
    from PyQt6.QtCore import QObject, pyqtSignal

    class _Dispatcher(QObject):
        # Emitted from any thread; the slot runs in the thread the object lives
        # in (the UI thread), because the connection is queued across threads.
        submitted = pyqtSignal(object)

        def __init__(self):
            super().__init__()
            self.submitted.connect(self._run)

        def _run(self, job):
            job()

    _dispatcher = _Dispatcher()


def run_on_ui_thread(fn: Callable[[], object], timeout: float = 5.0):
    """Run `fn` on the Qt UI thread and return its result (or raise its exception).

    Qt objects such as the clipboard may only be used from that thread, and the
    local server runs elsewhere.
    """
    dispatcher = _dispatcher
    if dispatcher is None:
        raise WindowNotRunning("This needs the GilzaCode window, which is not open in this process.")
    if threading.current_thread() is threading.main_thread():
        return fn()
    done = threading.Event()
    outcome: dict = {}

    def job():
        try:
            outcome["value"] = fn()
        except BaseException as exc:  # handed back to the waiting thread
            outcome["error"] = exc
        finally:
            done.set()

    dispatcher.submitted.emit(job)
    if not done.wait(timeout):
        raise TimeoutError(f"The GilzaCode window did not answer within {timeout:g} s.")
    if "error" in outcome:
        raise outcome["error"]
    return outcome.get("value")


# ── The window's handlers ───────────────────────────────────────────────────

#: Wayland app id and X11 desktop-file association: install.sh writes gilzacode.desktop.
DESKTOP_FILE_NAME = "gilzacode"


def _log(message: str) -> None:
    print(f"[GilzaCode] QtWebEngine: {message}", file=sys.stderr, flush=True)


def permission_granted(permission_type, types) -> bool:
    """Whether a QtWebEngine permission request of `permission_type` is granted.

    Microphone and camera are granted without a prompt; everything else is denied.
    """
    return permission_type in (types.MediaAudioCapture, types.MediaVideoCapture, types.MediaAudioVideoCapture)


def renderer_failure_kind(status, statuses) -> str | None:
    """The `failure_action` kind for a ``renderProcessTerminated`` status, or None.

    A normal termination is the page being closed or replaced, not a failure.
    """
    if status == statuses.NormalTerminationStatus:
        return None
    return "RenderProcessExited"


def renderer_terminated_handler(reload: Callable[[], object], show: Callable[[str], None],
                                log: Callable[[str], None], statuses,
                                clock: Callable[[], float] | None = None):
    """The ``renderProcessTerminated`` handler; the policy is `webview2.failure_action`."""
    clock = clock or time.monotonic
    state = {"last_reload": None}

    def on_terminated(status, exit_code):
        name = getattr(status, "name", str(status))
        kind = renderer_failure_kind(status, statuses)
        if kind is None:
            return
        now = clock()
        action = failure_action(kind, state["last_reload"], now)
        log(f"renderer terminated ({name}, exit code {exit_code}) -> {action}")
        if action == RELOAD:
            state["last_reload"] = now
            reload()
        elif action == ASK_RESTART:
            show(f"renderer {name}, exit code {exit_code}")

    return on_terminated


def pdf_path_for(chosen: str) -> str:
    """The file a print is saved to: what the user chose, with ``.pdf`` added if missing."""
    return chosen if chosen.lower().endswith(".pdf") else chosen + ".pdf"


def install_handlers(window, log: Callable[[str], None] = _log,
                     restart: Callable[[], object] | None = None,
                     fit: Callable[[int, int], tuple[int, int]] | None = None) -> None:
    """Connect the QtWebEngine signals GilzaCode handles, for a pywebview `window`.

    Must be called before ``webview.start``; the work happens in ``before_show``.
    `restart` relaunches the application; it is offered when the renderer keeps dying.
    `fit` maps the primary screen's available size to the window's first size.
    """

    def before_show(window):
        native = getattr(window, "native", None)
        view = getattr(native, "webview", None)
        if type(native).__module__ != "webview.platforms.qt" or view is None:
            # require_runtime passed, so this is not expected; say so rather
            # than run without the handlers and without a word.
            log(f"the window is not pywebview's Qt window ({type(native).__module__}.{type(native).__name__}); "
                "permissions, full screen, printing and downloads will not be handled.")
            return
        from PyQt6.QtCore import QStandardPaths, QTimer
        from PyQt6.QtWebEngineCore import QWebEnginePage, QWebEnginePermission, QWebEngineSettings
        from PyQt6.QtWidgets import QApplication, QFileDialog, QMessageBox

        _install_dispatcher()
        QApplication.instance().setDesktopFileName(DESKTOP_FILE_NAME)
        if fit is not None:
            available = QApplication.primaryScreen().availableGeometry()
            width, height = fit(available.width(), available.height())
            native.resize(width, height)
            native.move(available.x() + (available.width() - width) // 2,
                        available.y() + (available.height() - height) // 2)
        page = view.page()

        def on_permission(permission):
            if permission_granted(permission.permissionType(), QWebEnginePermission.PermissionType):
                permission.grant()
            else:
                permission.deny()

        try:
            page.featurePermissionRequested.disconnect(page.onFeaturePermissionRequested)
        except (TypeError, RuntimeError, AttributeError):
            pass  # not connected in this pywebview version
        page.permissionRequested.connect(on_permission)

        page.settings().setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)

        def on_fullscreen(request):
            request.accept()
            if bool(request.toggleOn()) != bool(getattr(native, "is_fullscreen", False)):
                native.toggle_fullscreen()

        page.fullScreenRequested.connect(on_fullscreen)

        def show_failure(reason: str) -> None:
            if restart is None:
                QMessageBox.critical(native, FAILURE_TITLE, FAILURE_BODY_NO_RESTART.format(reason=reason))
                return
            answer = QMessageBox.question(native, FAILURE_TITLE, FAILURE_BODY.format(reason=reason))
            if answer == QMessageBox.StandardButton.Yes:
                log("restarting GilzaCode after the renderer failure.")
                restart()

        # Reloading from inside the signal re-enters the page; let it return first.
        page.renderProcessTerminated.connect(renderer_terminated_handler(
            lambda: QTimer.singleShot(0, view.reload), show_failure, log,
            QWebEnginePage.RenderProcessTerminationStatus))

        def documents_dir() -> str:
            return QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DocumentsLocation)

        def on_print():
            title = page.title() or "document"
            chosen, _ = QFileDialog.getSaveFileName(native, "Save as PDF", os.path.join(documents_dir(), f"{title}.pdf"),
                                                    "PDF (*.pdf)")
            if chosen:
                page.printToPdf(pdf_path_for(chosen))

        def on_pdf_printed(path, success):
            if not success:
                log(f"printing to {path} failed.")
                QMessageBox.warning(native, "GilzaCode", f"The PDF could not be written to {path}.")

        page.printRequested.connect(on_print)
        page.pdfPrintingFinished.connect(on_pdf_printed)

        profile = page.profile()
        try:
            profile.downloadRequested.disconnect(native.on_download_requested)
        except (TypeError, RuntimeError, AttributeError):
            pass  # downloads were not enabled in pywebview

        def on_download(download):
            downloads = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation)
            suggested = download.suggestedFileName() or "download"
            chosen, _ = QFileDialog.getSaveFileName(native, "Save file", os.path.join(downloads, suggested))
            if not chosen:
                download.cancel()
                return
            download.setDownloadDirectory(os.path.dirname(chosen))
            download.setDownloadFileName(os.path.basename(chosen))
            download.accept()

        profile.downloadRequested.connect(on_download)

    window.events.before_show += before_show
