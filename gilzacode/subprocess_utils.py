"""Subprocess helpers: Unicode-safe text decoding, and the environment a started program gets."""

from __future__ import annotations

import os
import sys
from typing import Mapping

UTF8_TEXT_KWARGS = {
    "text": True,
    "encoding": "utf-8",
    "errors": "replace",
}


def utf8_text_kwargs() -> dict:
    """Return kwargs for subprocess text capture that never crashes on bytes."""
    return dict(UTF8_TEXT_KWARGS)


def host_environment(base: Mapping[str, str] | None = None, *, frozen: bool | None = None,
                     platform: str | None = None, bundle: str | None = None) -> dict[str, str]:
    """A copy of `base` (default ``os.environ``) for a program GilzaCode starts.

    Everywhere but a packaged Linux build this is a plain copy. There, the
    PyInstaller bootloader put the bundle's library folder at the front of
    ``LD_LIBRARY_PATH`` and kept the user's value in ``LD_LIBRARY_PATH_ORIG``
    (measured with PyInstaller 6.22). GilzaCode needs that, and so does
    QtWebEngineProcess, which Chromium starts with this process' environment:
    its RUNPATH reaches only the Qt libraries, and it also links NSS and X
    libraries the bundle carries next to them. The user's programs must not get
    it: the integrated terminal's bash, Claude Code, git, Tectonic, ``xdg-open``
    and the browser it opens would load the bundle's copies of libraries such
    as OpenSSL instead of their own. So the bundle's entry comes out here, and
    the user's own value goes back.

    Only a value that still starts with the bundle's folder is changed, so
    applying this twice (``claude_session_env`` composes two helpers that both
    call it) keeps the user's value.
    """
    env = dict(os.environ if base is None else base)
    frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    platform = sys.platform if platform is None else platform
    bundle = getattr(sys, "_MEIPASS", None) if bundle is None else bundle
    if not (frozen and platform.startswith("linux") and bundle):
        return env
    value = env.get("LD_LIBRARY_PATH")
    if value is None or value.split(":")[0] != bundle:
        return env
    original = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if original is not None:
        env["LD_LIBRARY_PATH"] = original
    else:
        env.pop("LD_LIBRARY_PATH")
    return env
