#!/usr/bin/env bash
# GilzaCode uninstaller for Linux (the counterpart of uninstall.ps1).
# Application files are removed by default. Global data (~/.gilzacode, or
# GILZACODE_HOME) is removed only with --purge, after a typed confirmation.
# Project folders are never touched.
set -euo pipefail

INSTALL_DIR="$HOME/.local/share/GilzaCode"
APP_DIR="$INSTALL_DIR/GilzaCode"
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/gilzacode.desktop"
PURGE=false
ASSUME_YES=false

usage() {
    printf '%s\n' \
        "Usage: uninstall.sh [--purge] [--yes]" \
        "" \
        "  --purge  Also remove GilzaCode's global data (settings, project list, voices)." \
        "           Project folders are never removed." \
        "  --yes    Confirm --purge without an interactive prompt."
}

for argument in "$@"; do
    case "$argument" in
        --purge) PURGE=true ;;
        --yes) ASSUME_YES=true ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
    esac
done

data_dir() {
    local dir="${GILZACODE_HOME:-}"
    printf '%s\n' "${dir:-$HOME/.gilzacode}"
}

# Resolve and confirm the destructive target before changing anything, so a
# rejected or unsafe purge cannot leave a half-uninstalled application.
PURGE_DIR=""
if $PURGE; then
    PURGE_DIR="$(data_dir)"
    case "$PURGE_DIR" in
        /*) ;;
        *) printf 'Refusing to purge a relative data directory: %s\n' "$PURGE_DIR" >&2; exit 1 ;;
    esac
    canonical="$PURGE_DIR"
    [[ -d "$PURGE_DIR" ]] && canonical="$(cd "$PURGE_DIR" && pwd -P)"
    case "$canonical" in
        ""|/|"$(cd "$HOME" && pwd -P)")
            printf 'Refusing to purge unsafe data directory: %s\n' "$PURGE_DIR" >&2
            exit 1 ;;
    esac
    if ! $ASSUME_YES; then
        if ! exec 3<> /dev/tty; then
            printf 'Cannot ask for confirmation. Re-run with --purge --yes after checking this path: %s\n' "$PURGE_DIR" >&2
            exit 1
        fi
        printf 'Remove all GilzaCode global data at %s? Type "remove" to continue: ' "$PURGE_DIR" >&3
        IFS= read -r confirmation <&3 || confirmation=""
        exec 3>&-
        if [[ "$confirmation" != "remove" ]]; then
            printf '%s\n' "Global data will be preserved."
            PURGE=false
        fi
    fi
fi

# Anything started from the installation: the window, the MCP bridge Claude
# Code runs, Tectonic, pandoc. Removing their files under them is refused, as
# on Windows, where the files would be locked.
running=""
for pid in /proc/[0-9]*; do
    exe="$(readlink "$pid/exe" 2>/dev/null || true)"
    if [[ -n "$exe" && "$exe" == "$INSTALL_DIR/"* ]]; then
        running="$running ${exe##*/} (PID ${pid#/proc/})"
    fi
done
if [[ -n "$running" ]]; then
    printf 'Programs started from the GilzaCode folder are still running:%s. Close GilzaCode (and any Claude Code session it started) and run the uninstaller again.\n' "$running" >&2
    exit 1
fi

echo "Uninstalling GilzaCode..."
# This script lives inside the folder it removes; leave it first.
cd /

# Application files first: if they cannot be removed, the menu entry stays, so
# the installation remains visible and can be uninstalled again, and nothing is
# purged for an uninstall that did not happen.
if [[ -d "$INSTALL_DIR" ]]; then
    if ! rm -rf -- "$INSTALL_DIR"; then
        printf 'Could not remove %s. Close any program using files in it and run the uninstaller again.\n' "$INSTALL_DIR" >&2
        exit 1
    fi
fi

# Only a menu entry that starts this installation is removed.
if [[ -f "$DESKTOP_FILE" ]] && grep -Fqx "Exec=\"$APP_DIR/GilzaCode\"" "$DESKTOP_FILE"; then
    rm -f -- "$DESKTOP_FILE"
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true
    fi
fi

if $PURGE; then
    rm -rf -- "$PURGE_DIR"
    printf 'Removed global data at %s. Project folders were preserved.\n' "$PURGE_DIR"
fi

echo "GilzaCode was removed."
if ! $PURGE; then
    printf 'Settings, the project list and downloaded voices are kept in %s; delete that folder to remove them too. Project folders were not touched.\n' "$(data_dir)"
fi
