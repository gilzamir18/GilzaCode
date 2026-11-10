# GilzaCode

A Windows desktop workspace for reading and writing — PDF with AI-assisted reading,
LaTeX, Markdown — where the agent is [Claude Code](https://code.claude.com).

GilzaCode reuses the interface of GilzaBots and connects it to Claude Code through
an MCP server of the application. See [PROJECT_DESIGN.md](./PROJECT_DESIGN.md).

## Status

Phase 1 of 4: the window, the local server and its session boundary, files, projects,
settings and clipboard. The interface itself arrives in phase 2.

## Requirements

- Windows 11 (WebView2 Runtime and .NET Framework 4.6.2+, both shipped with Windows 11)
- Python 3.12+
- Claude Code (`claude` on `PATH`) for the agent features

## Development

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e .[dev]
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe -m gilzacode
```

Set `GILZACODE_DEVTOOLS=1` to open the window with developer tools, and
`GILZACODE_HOME` to use a data folder other than `~/.gilzacode`.
