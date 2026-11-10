"""Entry point of the packaged ``gilzacode-mcp.exe``, the MCP bridge Claude Code starts.

A console executable on purpose: Claude Code speaks to it over stdin/stdout,
which a windowed (GUI-subsystem) PyInstaller build does not provide reliably.
"""

from gilzacode.mcp_bridge import main

if __name__ == "__main__":
    raise SystemExit(main())
