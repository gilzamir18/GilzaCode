# PyInstaller spec for GilzaCode on Windows. Run through build_exe.ps1.
#
# Two executables share one folder (dist/GilzaCode/):
#   GilzaCode.exe      the window (windowed)
#   gilzacode-mcp.exe  the MCP bridge Claude Code starts over stdio (console)
# The Qt bindings are excluded: the window is WebView2 through pywebview's WinForms
# backend, and --collect-all webview would otherwise pull Qt in from any
# environment that has it (as in GilzaBots' build_exe.ps1).

import os

from PyInstaller.utils.hooks import collect_all

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
TOOLS = os.path.join(ROOT, "build", "tools", "bin")

import winpty  # noqa: E402

datas = [
    (os.path.join(ROOT, "gilzacode", "static"), os.path.join("gilzacode", "static")),
    (TOOLS, "bin"),
    (os.path.join(ROOT, "uninstall.ps1"), "."),
]
binaries = [(os.path.join(os.path.dirname(winpty.__file__), "winpty-agent.exe"), "winpty")]
hiddenimports = []
for package in ("aiohttp", "webview", "pythonnet", "clr_loader", "winpty", "pymupdf", "onnxruntime"):
    d, b, h = collect_all(package)
    datas += d
    binaries += b
    hiddenimports += h

EXCLUDES = ["PyQt6", "PyQt5", "PySide6", "PySide2", "qtpy", "tkinter"]

app = Analysis(
    [os.path.join(ROOT, "packaging", "entry_gilzacode.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + ["gilzacode.mcp_bridge"],
    excludes=EXCLUDES,
    noarchive=False,
)
bridge = Analysis(
    [os.path.join(ROOT, "packaging", "entry_mcp.py")],
    pathex=[ROOT],
    excludes=EXCLUDES + ["webview", "pymupdf", "fitz", "onnxruntime", "numpy", "PIL", "winpty"],
    noarchive=False,
)

app_pyz = PYZ(app.pure)
bridge_pyz = PYZ(bridge.pure)

app_exe = EXE(
    app_pyz, app.scripts, [],
    exclude_binaries=True,
    name="GilzaCode",
    icon=os.path.join(ROOT, "packaging", "GilzaCode.ico"),
    console=False,
)
bridge_exe = EXE(
    bridge_pyz, bridge.scripts, [],
    exclude_binaries=True,
    name="gilzacode-mcp",
    icon=os.path.join(ROOT, "packaging", "GilzaCode.ico"),
    console=True,
)

coll = COLLECT(
    app_exe, app.binaries, app.datas,
    bridge_exe, bridge.binaries, bridge.datas,
    name="GilzaCode",
)
