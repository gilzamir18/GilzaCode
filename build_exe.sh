#!/usr/bin/env bash
# Builds the Linux package: dist/GilzaCode/ (GilzaCode + gilzacode-mcp) and
# dist/GilzaCode-linux-x64.tar.gz, which install.sh installs.
#
#   ./build_exe.sh
#
# Uses .venv when present, else the python3 on PATH (3.12 or newer). Build on
# the oldest Linux the release supports (Ubuntu 22.04): PyInstaller copies the
# build machine's Python and libraries, and they need that machine's glibc or a
# newer one. release.yml builds in an ubuntu:22.04 container for that reason.
#
# The libraries the window links that a stock image lacks must be installed on
# the build machine so they are copied into the bundle (release.yml installs them):
#   the nine X11 client libraries Qt's xcb plugin links:
#     libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-render-util0
#     libxcb-shape0 libxcb-util1 libxcb-xkb1 libxkbcommon-x11-0
#   and the X libraries QtWebEngineProcess links:
#     libxcomposite1 libxdamage1 libxrandr2 libxtst6 libxkbfile1
# scripts/check_bundle_libraries.py refuses a bundle that lacks any of them.

set -euo pipefail
cd "$(dirname "$0")"

echo "=========================================="
echo "         GilzaCode - Linux build          "
echo "=========================================="

PYTHON="${PYTHON:-python3}"
if [[ -x .venv/bin/python ]]; then
    echo "[env] Using the virtual environment in .venv"
    PYTHON=".venv/bin/python"
fi

TECTONIC_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz"
PANDOC_VERSION="3.10"
PANDOC_URL="https://github.com/jgm/pandoc/releases/download/$PANDOC_VERSION/pandoc-$PANDOC_VERSION-linux-amd64.tar.gz"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
    echo "This script builds the Linux x64 package; run it on Linux x86_64." >&2
    exit 1
fi

echo -e "\n[1/6] Python dependencies"
"$PYTHON" -m pip install --quiet pyinstaller
"$PYTHON" -m pip install --quiet -e .   # editable: the spec reads the sources from this folder

# The Qt packaged here is the Qt every install.sh user gets.
echo -e "\n[2/6] Qt runtime"
"$PYTHON" scripts/check_qt_runtime.py

echo -e "\n[3/6] Interface (gui/)"
(cd gui && npm ci --no-audit --no-fund && npm run build)
if [[ ! -f gilzacode/static/index.html ]]; then
    echo "The interface build produced no gilzacode/static/index.html." >&2
    exit 1
fi

echo -e "\n[4/6] Bundled tools (Tectonic, pandoc)"
TOOLS="build/tools/bin"
DOWNLOADS="build/tools/downloads"
mkdir -p "$TOOLS" "$DOWNLOADS"
if [[ ! -x "$TOOLS/tectonic" ]]; then
    # The musl build is statically linked, so it runs on every supported release.
    echo "Downloading $TECTONIC_URL"
    curl -fsSL "$TECTONIC_URL" -o "$DOWNLOADS/tectonic.tar.gz"
    tar -xzf "$DOWNLOADS/tectonic.tar.gz" -C "$TOOLS" tectonic
fi
if [[ ! -x "$TOOLS/pandoc" ]]; then
    echo "Downloading $PANDOC_URL"
    curl -fsSL "$PANDOC_URL" -o "$DOWNLOADS/pandoc.tar.gz"
    rm -rf "$DOWNLOADS/pandoc"
    mkdir -p "$DOWNLOADS/pandoc"
    tar -xzf "$DOWNLOADS/pandoc.tar.gz" -C "$DOWNLOADS/pandoc"
    PANDOC_BIN="$(find "$DOWNLOADS/pandoc" -type f -name pandoc | head -n 1)"
    if [[ -z "$PANDOC_BIN" ]]; then
        echo "pandoc was not found in the downloaded archive." >&2
        exit 1
    fi
    cp "$PANDOC_BIN" "$TOOLS/pandoc"
fi
chmod +x "$TOOLS/tectonic" "$TOOLS/pandoc"
"$TOOLS/tectonic" --version
"$TOOLS/pandoc" --version | head -n 1

echo -e "\n[4.5/6] Google OAuth client for Cloud sync"
# With GILZACODE_GDRIVE_CLIENT_ID/_SECRET set, the build embeds the client and
# "Connect with Google" is one click. Without them the app still works, and a
# client injected earlier (the git-ignored file exists) is embedded as is.
if [[ -n "${GILZACODE_GDRIVE_CLIENT_ID:-}" ]]; then
    "$PYTHON" scripts/embed_google_client.py --from-env
fi
if [[ -f gilzacode/cloud/providers/bundled_google_client.json ]]; then
    echo "The Google OAuth client is embedded."
else
    echo "WARNING: no Google OAuth client: Cloud sync in this build needs a user-supplied client." >&2
fi

echo -e "\n[5/6] PyInstaller"
"$PYTHON" -m PyInstaller packaging/GilzaCode-linux.spec --noconfirm --clean --distpath dist --workpath build/pyinstaller
BUNDLE="dist/GilzaCode"
for exe in GilzaCode gilzacode-mcp; do
    if [[ ! -x "$BUNDLE/$exe" ]]; then
        echo "$exe is missing from $BUNDLE." >&2
        exit 1
    fi
done

# PyInstaller only warns when a dependency is missing from this machine, and
# the bundle would then start only where the user happens to have it.
"$PYTHON" scripts/check_bundle_libraries.py "$BUNDLE"

# The bridge is what Claude Code starts; a build whose bridge cannot answer
# `initialize` over stdio is not shipped.
PROBE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}'
ANSWER="$(printf '%s\n' "$PROBE" | "$BUNDLE/gilzacode-mcp")"
if [[ "$ANSWER" != *'"protocolVersion"'*'"2025-11-25"'* ]]; then
    echo "The bundled gilzacode-mcp did not answer initialize. Output: $ANSWER" >&2
    exit 1
fi
echo "Bundled bridge answers initialize."

echo -e "\n[6/6] Release archive"
ARCHIVE="dist/GilzaCode-linux-x64.tar.gz"
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" -C dist GilzaCode

echo -e "\n=========================================="
echo "Build finished."
echo "  Folder:  $BUNDLE"
echo "  Archive: $ARCHIVE ($(du -m "$ARCHIVE" | cut -f1) MB)"
echo "  Install: ./install.sh --source $ARCHIVE"
echo "=========================================="
