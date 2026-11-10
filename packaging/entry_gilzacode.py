"""Entry point of the packaged ``GilzaCode.exe`` (the window). Built by ``GilzaCode.spec``.

The frozen-build setup is GilzaBots' (``main.py``):

* a windowed PyInstaller build has no usable stdout/stderr, so UTF-8 streams are
  guaranteed before anything prints;
* pythonnet (pywebview's WinForms/WebView2 backend) is pointed at the bundled
  Python DLL;
* ``winpty-agent.exe`` is put on PATH for the integrated terminal;
* child processes started without explicit flags get ``CREATE_NO_WINDOW``, so
  Tectonic or ``claude -p`` do not flash a console window.
"""

import io
import os
import subprocess
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

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    import ctypes
    import glob

    meipass = sys._MEIPASS
    os.add_dll_directory(meipass)
    python_dlls = glob.glob(os.path.join(meipass, "python3*.dll"))
    if python_dlls:
        os.environ["PYTHONNET_PYDLL"] = python_dlls[0]
        try:
            ctypes.CDLL(python_dlls[0])
        except OSError:
            pass
    for candidate in (meipass, os.path.join(meipass, "winpty")):
        if os.path.isfile(os.path.join(candidate, "winpty-agent.exe")):
            os.environ["PATH"] = candidate + os.pathsep + os.environ.get("PATH", "")
            break

if sys.platform == "win32":
    _original_popen_init = subprocess.Popen.__init__

    def _popen_without_console(self, *args, **kwargs):
        if "creationflags" not in kwargs:
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        _original_popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _popen_without_console

from gilzacode.__main__ import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
