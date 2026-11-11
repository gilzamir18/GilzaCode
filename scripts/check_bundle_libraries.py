#!/usr/bin/env python
"""Refuse a Linux bundle that only starts on machines with extra packages.

PyInstaller copies a binary's shared-library dependencies from the machine that
runs the build. A dependency that is not installed there is reported with a
"Library not found" warning and the build carries on, so the bundle ships
without it and works only where the user happens to have it. That is how the
release came to need ``apt install libxcb-cursor0`` and friends: Qt's xcb
platform plugin links nine X11 client libraries that the GitHub runner does not
have, and on a desktop without them Qt aborts with "no Qt platform plugin could
be initialized" before the window exists.

This gate runs ``ldd`` on what the application loads to open its window — the
platform plugins, their GL integrations, QtWebEngine and Python — with the
``LD_LIBRARY_PATH`` the PyInstaller bootloader sets, and refuses every
dependency that resolves outside the bundle or not at all. The libraries
PyInstaller excludes on purpose (glibc, the GL/EGL/DRM driver stack,
``libxcb.so.1``, Wayland's client libraries) belong to the user's graphics stack
and are allowed to come from the system; the gate asks PyInstaller itself which
those are rather than keeping a copy of its list.

    python scripts/check_bundle_libraries.py dist/GilzaCode

Copied from GilzaBots (``scripts/check_bundle_libraries.py``); build_exe.sh runs it.

Exit codes: 0 when every dependency is bundled or host-provided, 1 otherwise.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Callable, Iterable

# Relative to the bundle's contents directory (`_internal`). Globs, because the
# Python version is part of the library name.
ROOTS = (
    "PyQt6/Qt6/plugins/platforms/libqxcb.so",
    "PyQt6/Qt6/plugins/platforms/libqwayland.so",
    "PyQt6/Qt6/plugins/xcbglintegrations/libqxcb-glx-integration.so",
    "PyQt6/Qt6/plugins/xcbglintegrations/libqxcb-egl-integration.so",
    "PyQt6/Qt6/libexec/QtWebEngineProcess",
    "PyQt6/QtWebEngineWidgets.abi3.so",
    "libpython3*.so*",
)

_LDD_LINE = re.compile(r"^\s*(\S+)\s+=>\s+(not found|\S+)")


def contents_dir(bundle: Path) -> Path:
    """The directory PyInstaller puts libraries in: `_internal` since 6.0."""
    internal = bundle / "_internal"
    return internal if internal.is_dir() else bundle


def parse_ldd(output: str) -> list[tuple[str, str | None]]:
    """``(soname, resolved path or None)`` for every ``name => ...`` line.

    Lines without ``=>`` (the vDSO, the program interpreter) name nothing a
    bundle could carry and are skipped.
    """
    resolved = []
    for line in output.splitlines():
        match = _LDD_LINE.match(line)
        if not match:
            continue
        name, target = match.groups()
        resolved.append((name, None if target == "not found" else target))
    return resolved


def run_ldd(binary: Path, library_dir: Path) -> str:
    env = {**os.environ, "LD_LIBRARY_PATH": str(library_dir), "LC_ALL": "C"}
    result = subprocess.run(["ldd", str(binary)], capture_output=True, text=True, env=env, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ldd {binary} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


#: Libraries GilzaCode's spec leaves to the host although PyInstaller would
#: bundle them, because the system's Mesa drivers load them too and need the
#: system's version: libgbm and libstdc++ (packaging/GilzaCode-linux.spec has
#: the measurements). Keep the two lists equal.
HOST_LIBRARIES = ("libgbm.so", "libstdc++.so")


def pyinstaller_leaves_to_host(soname: str) -> bool:
    """True for a library the bundle deliberately leaves to the user's system."""
    from PyInstaller.depend import dylib

    return soname.startswith(HOST_LIBRARIES) or not dylib.include_library(soname)


def _inside(path: str, root: Path) -> bool:
    real = Path(os.path.realpath(path))
    real_root = Path(os.path.realpath(root))
    return real == real_root or real_root in real.parents


def find_roots(library_dir: Path, patterns: Iterable[str] = ROOTS) -> tuple[list[Path], list[str]]:
    found, missing = [], []
    for pattern in patterns:
        matches = sorted(path for path in library_dir.glob(pattern) if path.is_file())
        if matches:
            found.extend(matches)
        else:
            missing.append(pattern)
    return found, missing


def bundle_problems(
    bundle: Path,
    *,
    patterns: Iterable[str] = ROOTS,
    ldd: Callable[[Path, Path], str] = run_ldd,
    leaves_to_host: Callable[[str], bool] = pyinstaller_leaves_to_host,
) -> list[str]:
    library_dir = contents_dir(bundle)
    roots, missing_roots = find_roots(library_dir, patterns)
    problems = [
        f"{pattern} is not in the bundle; the startup path this gate checks has moved, update ROOTS"
        for pattern in missing_roots
    ]

    reported = set()
    for root in roots:
        for soname, target in parse_ldd(ldd(root, library_dir)):
            if soname in reported or leaves_to_host(soname):
                continue
            if target is not None and _inside(target, bundle):
                continue
            reported.add(soname)
            needed_by = root.relative_to(library_dir).as_posix()
            if target is None:
                problems.append(
                    f"{soname} (needed by {needed_by}) is not installed on the build machine, "
                    "so PyInstaller could not bundle it"
                )
            else:
                problems.append(
                    f"{soname} (needed by {needed_by}) was not bundled; it only resolves to the "
                    f"build machine's {target}, which users do not have by default"
                )
    return problems


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: check_bundle_libraries.py <PyInstaller dist directory>", file=sys.stderr)
        return 2
    bundle = Path(args[0])
    if not bundle.is_dir():
        print(f"{bundle} is not a directory", file=sys.stderr)
        return 2

    problems = bundle_problems(bundle)
    if not problems:
        print(f"Every library the window needs is bundled or host-provided ({bundle}).")
        return 0

    annotate = os.environ.get("GITHUB_ACTIONS") == "true"
    for problem in problems:
        print(f"::error::{problem}" if annotate else f"ERROR: {problem}", file=sys.stderr)
    print(
        "Install the package that provides each library on the build machine before running "
        "PyInstaller (release.yml lists them for the release build), so it is copied into the bundle.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
