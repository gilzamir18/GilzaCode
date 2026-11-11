"""Entry point of the packaged Linux ``GilzaCode`` (the window). Built by ``GilzaCode-linux.spec``.

The Windows entry point (``entry_gilzacode.py``) is about pythonnet, winpty and
console windows, none of which exist here. What a frozen Linux build needs here
is UTF-8 streams, guaranteed before anything prints.

The ``LD_LIBRARY_PATH`` the PyInstaller bootloader set is deliberately left in
this process' environment: QtWebEngineProcess, which Chromium starts with it,
finds the NSS and X libraries the bundle carries only through it. The programs
GilzaCode itself starts get the user's own value instead
(``subprocess_utils.host_environment``).
"""

import io
import os
import sys

os.environ["PYTHONUTF8"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"


def _utf8_stream(stream):
    if stream is None:
        return open(os.devnull, "w", encoding="utf-8", errors="replace")
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
        return stream
    except (AttributeError, ValueError):
        pass
    buffer = getattr(stream, "buffer", None)
    if buffer is not None:
        return io.TextIOWrapper(buffer, encoding="utf-8", errors="replace", line_buffering=True)
    return open(os.devnull, "w", encoding="utf-8", errors="replace")


sys.stdout = _utf8_stream(sys.stdout)
sys.stderr = _utf8_stream(sys.stderr)

from gilzacode.__main__ import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
