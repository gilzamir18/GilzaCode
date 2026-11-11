#!/usr/bin/env python
"""Refuse to package a Qt that is known to break the GilzaCode window on Linux.

Adapted from GilzaBots (``scripts/check_qt_runtime.py``). The Qt a user runs is
chosen at build time: install.sh downloads the release build_exe.sh produced
and never resolves a Python package. The range declared in pyproject.toml
therefore protects users only if the build confirms it.

Two checks:

1. The Qt floors pyproject.toml declares for Linux, against the installed
   distributions. Below them GilzaBots measured real failures (Qt 6.8's
   Chromium 122 cannot open a PDF: pdf.js calls ``URL.parse``).
2. All four Qt packages from the same Qt minor release. PyQt6-WebEngine does
   not constrain PyQt6-Qt6, so a new PyQt6 installs next to the previous
   WebEngine, and QtWebEngineWidgets then fails to load.

GilzaBots' third check (QtWebEngine then onnxruntime in one process, a C++
runtime conflict) exists only on Windows, where GilzaCode has no Qt.

    python scripts/check_qt_runtime.py

Exit codes: 0 when every check passes, 1 otherwise.
"""

from __future__ import annotations

import os
import re
import sys
import tomllib
from importlib import metadata
from pathlib import Path
from typing import Callable

from packaging.requirements import Requirement
from packaging.version import Version

ROOT = Path(__file__).resolve().parent.parent

QT_PACKAGES = ("pyqt6", "pyqt6-qt6", "pyqt6-webengine", "pyqt6-webengine-qt6")

#: The marker environment the Linux build resolves pyproject.toml's dependencies in.
LINUX = {"sys_platform": "linux", "platform_system": "Linux"}


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def qt_floors(pyproject: Path = ROOT / "pyproject.toml") -> dict[str, Version]:
    """The minimum version pyproject.toml declares on Linux for each Qt package."""
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    floors: dict[str, Version] = {}
    for line in data["project"]["dependencies"]:
        req = Requirement(line)
        name = _normalize(req.name)
        if name not in QT_PACKAGES or (req.marker is not None and not req.marker.evaluate(LINUX)):
            continue
        mins = [Version(s.version) for s in req.specifier if s.operator in (">=", "==")]
        if mins:
            floors[name] = max(mins)
    return floors


def version_problems(floors: dict[str, Version], installed: Callable[[str], str] = metadata.version) -> list[str]:
    problems = []
    for name in QT_PACKAGES:
        floor = floors.get(name)
        if floor is None:
            problems.append(f"pyproject.toml declares no Linux floor for {name}")
            continue
        try:
            found = Version(installed(name))
        except metadata.PackageNotFoundError:
            problems.append(f"{name} is not installed (needs >={floor})")
            continue
        if found < floor:
            problems.append(f"{name} {found} is installed, below the declared floor {floor}")
    return problems


def mixed_release_problem(installed: Callable[[str], str] = metadata.version) -> str | None:
    """Report Qt packages that do not all come from the same Qt minor release."""
    versions = {name: Version(installed(name)) for name in QT_PACKAGES}
    if len({v.release[:2] for v in versions.values()}) == 1:
        return None
    found = ", ".join(f"{name} {v}" for name, v in versions.items())
    return (f"the Qt packages come from different Qt releases ({found}). PyQt6-WebEngine "
            "is built against the Qt of its own release, so all four must share one "
            "major.minor; pyproject.toml declares a common ceiling for that.")


def main() -> int:
    problems = version_problems(qt_floors())
    if not problems:
        mixed = mixed_release_problem()
        if mixed:
            problems.append(mixed)
    if not problems:
        installed = ", ".join(f"{name} {metadata.version(name)}" for name in QT_PACKAGES)
        print(f"Qt runtime check passed: {installed}")
        return 0
    on_actions = os.environ.get("GITHUB_ACTIONS") == "true"
    for problem in problems:
        print(f"::error::{problem}" if on_actions else f"ERROR: {problem}", file=sys.stderr)
    print("Refusing to package this Qt (see the Qt range in pyproject.toml).", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
