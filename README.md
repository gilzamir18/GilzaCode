# GilzaCode

A Windows desktop workspace for reading and writing — PDF with AI-assisted reading,
LaTeX, Markdown — where the agent is [Claude Code](https://code.claude.com).

GilzaCode reuses the interface of GilzaBots and connects it to Claude Code through
an MCP server of the application. See [PROJECT_DESIGN.md](./PROJECT_DESIGN.md).

## Status

All four phases are done: the interface (editors, PDF viewer, LaTeX, Markdown, Git,
terminal) and its backend; Claude Code running in its own panel, with document actions
pasting their prompts into it unsent and Translate / Look up using `claude -p`; and an
MCP server through which Claude Code reads and drives the window (editor state and
selection, the PDF pane, opening files, revealing a line in the PDF, compiling LaTeX).
Packaging and an installer come next.

GilzaCode is free: no account, no subscription. The only thing a user needs besides
Windows is [Claude Code](https://code.claude.com). Donations are welcome through the
PayPal link in Settings > About.

## Requirements

- Windows 11 (WebView2 Runtime and .NET Framework 4.6.2+, both shipped with Windows 11)
- Claude Code (`claude` on `PATH`)
- For development: Python 3.12+ and Node.js

## Development

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e .[dev]
cd gui; npm ci; npm run build; cd ..     # builds the interface into gilzacode/static
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe -m gilzacode
```

Set `GILZACODE_DEVTOOLS=1` to open the window with developer tools, and
`GILZACODE_HOME` to use a data folder other than `~/.gilzacode`.
