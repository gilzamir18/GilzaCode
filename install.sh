#!/usr/bin/env bash
# =========================================================
# GilzaCode installer for Linux (per user, no administrator rights).
#
#   From a local build:  ./install.sh --source dist/GilzaCode-linux-x64.tar.gz
#   From a URL:          GILZACODE_DOWNLOAD_URL=https://.../GilzaCode-linux-x64.tar.gz ./install.sh
#   Latest release:      curl -fsSL https://raw.githubusercontent.com/gilzamir18/GilzaCode/HEAD/install.sh | bash
#
# The Linux counterpart of install.ps1, adapted from GilzaBots' install.sh.
# Supported: Ubuntu 22.04 or newer, x86_64. Besides that, the only thing
# GilzaCode needs is Claude Code (`claude`).
# =========================================================
set -euo pipefail

SOURCE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --source) SOURCE="${2:-}"; shift 2 ;;
        --source=*) SOURCE="${1#*=}"; shift ;;
        -h|--help)
            echo "Usage: install.sh [--source <GilzaCode-linux-x64.tar.gz path or URL>]"
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

echo "=========================================="
echo "           GilzaCode Installer            "
echo "=========================================="

INSTALL_DIR="$HOME/.local/share/GilzaCode"
APP_DIR="$INSTALL_DIR/GilzaCode"
ASSET_NAME="GilzaCode-linux-x64.tar.gz"
REPO_OWNER="gilzamir18"
REPO_NAME="GilzaCode"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$DESKTOP_DIR/gilzacode.desktop"

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "This installer is for Linux; on Windows use install.ps1." >&2
    exit 1
fi
case "$(uname -m)" in
    x86_64|amd64) ;;
    *) echo "Unsupported CPU architecture: $(uname -m). The Linux release is built for x86_64 only." >&2; exit 1 ;;
esac

# Extracting over a running copy would replace its files under it, leaving a
# mix of old and new versions behind (install.ps1 refuses for the same reason).
running_from() {
    local prefix="$1/" exe pid
    for pid in /proc/[0-9]*; do
        exe="$(readlink "$pid/exe" 2>/dev/null || true)"
        if [[ -n "$exe" && "$exe" == "$prefix"* ]]; then
            echo "${pid#/proc/}"
        fi
    done
}
if [[ -d "$INSTALL_DIR" && -n "$(running_from "$INSTALL_DIR")" ]]; then
    echo "GilzaCode is running from $INSTALL_DIR. Close it (and any Claude Code session it started) and run the installer again." >&2
    exit 1
fi

download() {
    local url="$1" output="$2" attempt
    for attempt in 1 2 3; do
        rm -f "$output"
        if curl -fL --retry 2 --retry-delay 2 -H "User-Agent: GilzaCode-Installer" "$url" -o "$output" && [[ -s "$output" ]]; then
            return 0
        fi
        if [[ "$attempt" -eq 3 ]]; then
            echo "Failed to download GilzaCode after 3 attempts." >&2
            return 1
        fi
        echo "Download failed. Retrying ($attempt/3)..."
        sleep $((2 * attempt))
    done
}

# Where the package comes from: --source (a .tar.gz path or URL), then
# GILZACODE_DOWNLOAD_URL, then the latest GitHub release.
LOCATION="${SOURCE:-${GILZACODE_DOWNLOAD_URL:-}}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [[ -n "$LOCATION" && -f "$LOCATION" ]]; then
    PACKAGE="$LOCATION"
else
    if [[ -z "$LOCATION" ]]; then
        LOCATION="https://github.com/$REPO_OWNER/$REPO_NAME/releases/latest/download/$ASSET_NAME"
    elif [[ ! "$LOCATION" =~ ^https?:// ]]; then
        echo "The package '$LOCATION' is neither an existing file nor an http(s) URL." >&2
        exit 1
    fi
    command -v curl >/dev/null 2>&1 || { echo "curl is required to download GilzaCode." >&2; exit 1; }
    PACKAGE="$WORK/$ASSET_NAME"
    echo "Downloading GilzaCode from $LOCATION"
    if ! download "$LOCATION" "$PACKAGE"; then
        echo "No GilzaCode package could be downloaded. Build one with build_exe.sh and run: install.sh --source dist/$ASSET_NAME" >&2
        exit 1
    fi
fi

# Unpack next to the installation first, so a broken package leaves the
# installed version untouched; then replace it, so files of a previous version
# do not linger next to the new ones.
echo "Extracting to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
STAGING="$(mktemp -d "$INSTALL_DIR/.staging.XXXXXX")"
trap 'rm -rf "$WORK" "$STAGING"' EXIT
tar -xzf "$PACKAGE" -C "$STAGING"
for required in GilzaCode/GilzaCode GilzaCode/gilzacode-mcp; do
    if [[ ! -x "$STAGING/$required" ]]; then
        echo "The package is incomplete: $required is missing." >&2
        exit 1
    fi
done
rm -rf "$APP_DIR"
mv "$STAGING/GilzaCode" "$APP_DIR"

EXE="$APP_DIR/GilzaCode"
# PyInstaller 6+ keeps data files in `_internal`.
ICON="$APP_DIR/_internal/gilzacode/window/GilzaCode.png"
UNINSTALLER="$APP_DIR/_internal/uninstall.sh"

echo "Creating the application menu entry..."
mkdir -p "$DESKTOP_DIR"
{
    echo "[Desktop Entry]"
    echo "Type=Application"
    echo "Name=GilzaCode"
    echo "Comment=Read and write with Claude Code"
    echo "Exec=\"$EXE\""
    if [[ -f "$ICON" ]]; then echo "Icon=$ICON"; fi
    echo "Terminal=false"
    echo "Categories=Office;TextEditor;Development;"
    echo "StartupWMClass=GilzaCode"
} > "$DESKTOP_FILE"
chmod 644 "$DESKTOP_FILE"
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo ""
echo "=========================================="
echo "      GilzaCode installed successfully!   "
echo "=========================================="
echo "Start it from the application menu, or run: $EXE"
if [[ -f "$UNINSTALLER" ]]; then
    echo "To uninstall: bash \"$UNINSTALLER\""
fi

# What GilzaCode needs and does not install for the user.
if ! command -v claude >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/claude" ]]; then
    echo ""
    echo "WARNING: Claude Code (claude) was not found. GilzaCode needs it for its Claude Code panel, Translate and Look up." >&2
    echo "GilzaCode needs the Claude Code CLI (the claude command), not the Claude desktop app. Install it with:" >&2
    echo "    curl -fsSL https://claude.ai/install.sh | bash" >&2
    echo "or from GilzaCode's Settings > Dependencies. Guide: https://code.claude.com/docs/en/setup" >&2
fi
