"""The Windows clipboard, read and written through the Win32 API.

Copied from GilzaBots (``win_clipboard.py``). The window is WebView2, and the
front-end sends every clipboard read and write to ``/api/clipboard/*``; this
module answers them the way Qt's clipboard did in GilzaBots:

- text comes back with ``\\n`` line ends and goes out with ``\\r\\n``, the conversion
  Qt's Windows clipboard backend performs in both directions;
- an image comes back as base64 PNG, and a clipboard holding no image (text, or
  files copied in Explorer) comes back as ``''``.

Only ``ctypes`` and Pillow (a base dependency) are used.
"""

from __future__ import annotations

import base64
import ctypes
import io
import sys
import time
from ctypes import wintypes

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

#: How long to keep retrying while another program holds the clipboard open.
OPEN_ATTEMPTS = 10
OPEN_RETRY_SECONDS = 0.02


class ClipboardError(OSError):
    """The clipboard could not be opened or written."""


def _api():
    if sys.platform != "win32":  # pragma: no cover - guarded by callers
        raise ClipboardError("the Win32 clipboard exists only on Windows")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    # Handles are pointer-sized; without explicit types ctypes truncates them to
    # 32 bits on 64-bit Python.
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.argtypes = []
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
    user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
    ]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.DestroyWindow.restype = wintypes.BOOL

    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.restype = wintypes.HGLOBAL
    return user32, kernel32


class _OpenClipboard:
    """``with _OpenClipboard(user32) as owner:`` — the clipboard, open and owned.

    Writing needs an owner window: with ``OpenClipboard(NULL)``, ``EmptyClipboard``
    sets the owner to NULL and the documentation says ``SetClipboardData`` then
    fails. A hidden ``STATIC`` window is the smallest window there is.
    """

    def __init__(self, user32):
        self.user32 = user32
        self.hwnd = None

    def __enter__(self):
        self.hwnd = self.user32.CreateWindowExW(0, "STATIC", None, 0, 0, 0, 0, 0, None, None, None, None)
        for attempt in range(OPEN_ATTEMPTS):
            if self.user32.OpenClipboard(self.hwnd):
                return self.hwnd
            if attempt + 1 < OPEN_ATTEMPTS:
                time.sleep(OPEN_RETRY_SECONDS)
        error = ctypes.get_last_error()
        self._destroy()
        raise ClipboardError(f"the clipboard is held by another program (Win32 error {error})")

    def __exit__(self, *_exc):
        self.user32.CloseClipboard()
        self._destroy()
        return False

    def _destroy(self):
        if self.hwnd:
            self.user32.DestroyWindow(self.hwnd)
            self.hwnd = None


def to_clipboard_text(text: str) -> str:
    """Line ends as Windows programs expect them on the clipboard."""
    return text.replace("\r\n", "\n").replace("\n", "\r\n")


def from_clipboard_text(text: str) -> str:
    return text.replace("\r\n", "\n")


def read_text() -> str:
    """The clipboard's text, or ``''`` when it holds none."""
    user32, kernel32 = _api()
    with _OpenClipboard(user32):
        if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return ""
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return ""
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return ""
        try:
            return from_clipboard_text(ctypes.wstring_at(pointer))
        finally:
            kernel32.GlobalUnlock(handle)


def write_text(text: str) -> None:
    """Replace the clipboard's contents with `text`. Raises `ClipboardError`."""
    user32, kernel32 = _api()
    data = (to_clipboard_text(text) + "\0").encode("utf-16-le")
    with _OpenClipboard(user32):
        if not user32.EmptyClipboard():
            raise ClipboardError(f"could not empty the clipboard (Win32 error {ctypes.get_last_error()})")
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not handle:
            raise ClipboardError(f"could not allocate clipboard memory (Win32 error {ctypes.get_last_error()})")
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            kernel32.GlobalFree(handle)
            raise ClipboardError(f"could not lock clipboard memory (Win32 error {ctypes.get_last_error()})")
        try:
            ctypes.memmove(pointer, data, len(data))
        finally:
            kernel32.GlobalUnlock(handle)
        # On success the system owns the memory; on failure it is still ours.
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            error = ctypes.get_last_error()
            kernel32.GlobalFree(handle)
            raise ClipboardError(f"could not set the clipboard text (Win32 error {error})")


def read_image_png_b64(grab=None) -> str:
    """The clipboard image as base64 PNG, or ``''`` when the clipboard holds none.

    Pillow's ``ImageGrab.grabclipboard`` reads the registered ``PNG`` format and
    ``CF_DIB``/``CF_DIBV5``; for files copied in Explorer it returns their paths,
    which are not an image of the clipboard and give ``''`` like Qt's
    ``QClipboard.image()`` did.
    """
    if grab is None:
        from PIL import ImageGrab

        grab = ImageGrab.grabclipboard
    try:
        image = grab()
    except OSError:
        return ""
    if image is None or isinstance(image, list):
        return ""
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode()
