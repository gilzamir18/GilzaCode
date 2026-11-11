"""The clipboard on Linux, through the Qt window's ``QClipboard``.

The front-end sends every clipboard read and write to ``/api/clipboard/*``
(``main.jsx``). On Windows the backend answers through Win32 (``win_clipboard``);
on Linux the window is Qt, whose clipboard speaks to both X11 and Wayland.

Same interface as ``win_clipboard``: ``read_text``, ``write_text`` and
``read_image_png_b64``, failing with `ClipboardError`.

``QClipboard`` may only be used on the UI thread, and the local server runs on
its own thread, so every call goes through ``window.qt.run_on_ui_thread``.
GilzaBots also tried a throwaway ``QApplication`` in a ``sys.executable -c``
subprocess when that failed; in a frozen build ``sys.executable`` is the
application itself, so that path could never have worked there and is not
copied. Without the window (``--browser``) there is no clipboard, and the
request fails saying so.
"""

from __future__ import annotations

import base64

from gilzacode.window.qt import WindowNotRunning, run_on_ui_thread


class ClipboardError(OSError):
    """The clipboard could not be read or written."""


def _on_ui(fn):
    try:
        return run_on_ui_thread(fn)
    except WindowNotRunning as exc:
        raise ClipboardError("The clipboard is available only in the GilzaCode window.") from exc
    except TimeoutError as exc:
        raise ClipboardError(str(exc)) from exc


def _clipboard():
    from PyQt6.QtWidgets import QApplication
    return QApplication.clipboard()


def read_text() -> str:
    return _on_ui(lambda: _clipboard().text())


def write_text(text: str) -> None:
    _on_ui(lambda: _clipboard().setText(text))


def _image_png_b64() -> str:
    from PyQt6.QtCore import QBuffer, QIODevice

    image = _clipboard().image()
    if image.isNull():
        return ""
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    if not image.save(buffer, "PNG"):
        raise ClipboardError("The clipboard image could not be encoded as PNG.")
    return base64.b64encode(bytes(buffer.data())).decode("ascii")


def read_image_png_b64() -> str:
    """The clipboard image as base64 PNG, or ``''`` when the clipboard holds none."""
    return _on_ui(_image_png_b64)
