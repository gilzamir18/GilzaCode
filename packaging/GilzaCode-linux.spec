# PyInstaller spec for GilzaCode on Linux. Run through build_exe.sh.
# (Windows: GilzaCode.spec, which this file does not touch.)
#
# Two executables share one folder (dist/GilzaCode/):
#   GilzaCode      the window (pywebview's Qt backend, QtWebEngine)
#   gilzacode-mcp  the MCP bridge Claude Code starts over stdio
#
# Qt is collected by PyInstaller's own PyQt6 hooks, which take what the imported
# modules need (QtWebEngineProcess, its resources and locales). The QML bindings
# are excluded, as in GilzaBots (design §2.16.1 there): QtWebEngineCore links
# libQt6Qml/libQt6Quick, which still come in as libraries, but the QtQml hook
# would add every QML plugin and, through them, Quick3D, Multimedia and more.
# The window is a widget and never loads QML.

import os

from PyInstaller.utils.hooks import collect_all

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
TOOLS = os.path.join(ROOT, "build", "tools", "bin")

datas = [
    (os.path.join(ROOT, "gilzacode", "static"), os.path.join("gilzacode", "static")),
    (os.path.join(ROOT, "gilzacode", "window", "GilzaCode.png"), os.path.join("gilzacode", "window")),
    (TOOLS, "bin"),
    (os.path.join(ROOT, "uninstall.sh"), "."),
]
# The Google OAuth client for Cloud sync, injected by scripts/embed_google_client.py
# (git-ignored). Without it the app still runs; connecting needs a user-supplied client.
BUNDLED_CLIENT = os.path.join(ROOT, "gilzacode", "cloud", "providers", "bundled_google_client.json")
if os.path.isfile(BUNDLED_CLIENT):
    datas.append((BUNDLED_CLIENT, os.path.join("gilzacode", "cloud", "providers")))
binaries = []
hiddenimports = [
    # pywebview reaches Qt through qtpy, which PyInstaller cannot follow.
    "PyQt6.QtWebEngineWidgets", "PyQt6.QtWebEngineCore", "PyQt6.QtWebChannel", "PyQt6.QtNetwork",
]
for package in ("aiohttp", "webview", "pymupdf", "onnxruntime"):
    d, b, h = collect_all(package)
    datas += d
    binaries += b
    hiddenimports += h
# collect_all("webview") lists every pywebview backend; only Qt exists here.
hiddenimports = [name for name in hiddenimports
                 if not name.startswith(("webview.platforms.winforms", "webview.platforms.edgechromium",
                                         "webview.platforms.mshtml", "webview.platforms.cocoa",
                                         "webview.platforms.android", "webview.platforms.gtk",
                                         "webview.platforms.cef"))]

EXCLUDES = ["PyQt5", "PySide6", "PySide2", "tkinter", "PyQt6.QtQml", "PyQt6.QtQuick", "PyQt6.QtQuickWidgets",
            "clr", "clr_loader", "pythonnet", "winpty"]

app = Analysis(
    [os.path.join(ROOT, "packaging", "entry_gilzacode_linux.py")],
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
    excludes=EXCLUDES + ["PyQt6", "qtpy", "webview", "pymupdf", "fitz", "onnxruntime", "numpy", "PIL"],
    noarchive=False,
)

# Libraries the user's graphics stack loads, which PyInstaller would bundle
# anyway. Everything in the bundle comes first on LD_LIBRARY_PATH, so the
# system's Mesa drivers, loaded into this process, would get the 22.04 copies.
# Each was measured on the bundle built on 22.04; removing it alone fixed it:
# - libgbm is Mesa's own and tied to its drivers: the window did not open on
#   Ubuntu 26.04 (X11, Wayland, Xvfb);
# - libstdc++ is older than what a newer Mesa (LLVM) needs: the window did not
#   open on Ubuntu 24.04 (GLX failed under Xvfb). The system's is always the
#   same or newer, since the build runs on the oldest supported release.
# Every desktop has both (libgbm1, libstdc++6). PyInstaller already leaves
# libGL, libEGL and libdrm to the host for the same reason.
# Keep in sync with HOST_LIBRARIES in scripts/check_bundle_libraries.py.
HOST_LIBRARIES = ("libgbm.so", "libstdc++.so")
app.binaries = [entry for entry in app.binaries
                if not os.path.basename(entry[0]).startswith(HOST_LIBRARIES)]

app_pyz = PYZ(app.pure)
bridge_pyz = PYZ(bridge.pure)

app_exe = EXE(
    app_pyz, app.scripts, [],
    exclude_binaries=True,
    name="GilzaCode",
    console=False,
)
bridge_exe = EXE(
    bridge_pyz, bridge.scripts, [],
    exclude_binaries=True,
    name="gilzacode-mcp",
    console=True,
)

coll = COLLECT(
    app_exe, app.binaries, app.datas,
    bridge_exe, bridge.binaries, bridge.datas,
    name="GilzaCode",
)
