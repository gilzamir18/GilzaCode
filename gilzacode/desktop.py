"""Handing a file, a folder or a web link to the desktop (Linux: ``xdg-open``).

On Windows the callers keep using the Windows shell (``os.startfile``) and
Python's ``webbrowser``, as before. On Linux ``webbrowser`` is not used: it
starts the browser with this process' environment, which in a packaged build
carries the bundle's ``LD_LIBRARY_PATH`` (``subprocess_utils.host_environment``),
and it takes no environment of its own.
"""

from __future__ import annotations

import subprocess

from gilzacode.subprocess_utils import host_environment

#: How long a desktop launcher is watched for an early failure. `xdg-open`
#: hands the target to the desktop and exits within milliseconds (GilzaBots).
DESKTOP_OPEN_FAILURE_WINDOW = 1.5


def open_with_desktop(target: str, *, popen=subprocess.Popen, window: float = DESKTOP_OPEN_FAILURE_WINDOW) -> None:
    """Open `target` (a path or a URL) with the desktop's handler. Raises `OSError`.

    The handler is not waited for (a file manager or a browser keeps running),
    only watched long enough to report a launcher that failed at once.
    """
    try:
        process = popen(["xdg-open", target], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE, start_new_session=True, env=host_environment())
    except FileNotFoundError as exc:
        raise OSError("xdg-open was not found; install xdg-utils to open files and links from GilzaCode.") from exc
    try:
        code = process.wait(timeout=window)
    except subprocess.TimeoutExpired:
        return
    if code != 0:
        detail = (process.stderr.read() or b"").decode("utf-8", "replace").strip() if process.stderr else ""
        raise OSError(f"xdg-open could not open {target} (exit status {code}){': ' + detail if detail else ''}.")


def open_url(url: str) -> bool:
    """Open a web link in the default browser; False when none could be started."""
    try:
        open_with_desktop(url)
    except OSError:
        return False
    return True
