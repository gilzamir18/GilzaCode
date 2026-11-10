"""``python -m gilzacode`` / ``gilzacode``: open the GilzaCode window."""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gilzacode", description="Open the GilzaCode window.")
    parser.add_argument("--port", type=int, default=None, help="port of the local server (default: first free from 3100)")
    parser.add_argument("--browser", action="store_true",
                        help="open the interface in the default browser instead of the window (development)")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    from gilzacode.launcher import run

    return run(port=args.port, browser=args.browser)


if __name__ == "__main__":
    raise SystemExit(main())
