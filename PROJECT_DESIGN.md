# GilzaCode Project Design

GilzaCode is a Windows desktop workspace for reading and writing: PDF with
AI-assisted reading, LaTeX with compile/preview/SyncTeX, Rich Text and WYSIWYG
editing, Markdown. It reuses the **interface** of GilzaBots and replaces GilzaBots'
own agent with **Claude Code**, connected through an MCP server of the
application. GilzaBots is unchanged; GilzaCode copies what it needs from it.

---

## 1. Architecture

```
GilzaCode.exe (pywebview + WebView2)
 ├─ Interface: React/Vite, reused from GilzaBots' gui_src (phase 2)
 ├─ Loopback server (aiohttp): files, projects, settings, clipboard,
 │    LaTeX/Tectonic, SyncTeX, PDF annotations, Git, terminal PTY, speech
 └─ connection file ~/.gilzacode/connection.json (url + bridge token)
        ▲  HTTP, Authorization: Bearer <bridge token>
        │
 gilzacode-mcp (stdio; started by Claude Code)            (phase 3)
        ▲  MCP tools; optional claude/channel push
        │
 Claude Code (CLI), normally running in the window's integrated terminal
```

There is **no agent loop and no model API call** in GilzaCode. The conversation
belongs to Claude Code.

## 2. Decisions and their evidence

These were measured with a throwaway prototype on 2026-11-09 (Claude Code
2.1.321, Windows 11, claude.ai Pro OAuth).

- **Host: a standalone window, not a VS Code extension.** The extension route
  would have meant porting the PDF and LaTeX surfaces into VS Code webviews.
  The window keeps the GilzaBots interface intact.
- **"Ask about" pastes into the Claude Code prompt without submitting.** The
  integrated terminal owns the PTY Claude Code runs in, so the excerpt is sent
  as a bracketed paste (`ESC[200~ … ESC[201~`). Measured: the text sits unsent
  in the composer, the user reviews it, and Enter submits it.
- **Channels are optional, not the primary path.** A custom channel
  (`claude/channel`) delivered an event and Claude called the server's tools
  back (7.1 s round trip). But a channel outside Anthropic's allowlist always
  needs `--dangerously-load-development-channels`, with a full-screen warning
  at every start, even when published in one's own marketplace.
- **The MCP bridge must stay on the handshake protocol.** Claude Code first
  probes `server/discover` at revision `2026-07-28` and falls back to
  `initialize` at `2025-11-25` when the probe is refused. The channel
  documentation states that a channel negotiating `2026-07-28` cannot deliver
  messages. A stock MCP Python SDK 2.x server answers the probe, so the bridge
  must not use the SDK's default negotiation.
- **Translate and Look up are one-off `claude -p` calls**, not chat turns:
  `claude -p --model haiku --tools "" --strict-mcp-config
  --no-session-persistence --setting-sources ""` with a task-specific system
  prompt. Measured ~2.5 s and ~US$0.0004 per translation. `--bare` is not
  usable with claude.ai OAuth (it accepts only `ANTHROPIC_API_KEY`).
- **Pronounce and dictation stay local** (Piper, Whisper), as in GilzaBots.

## 3. The loopback server (`gilzacode/server/`)

A new aiohttp server, organized by domain (`routes_files.py`,
`routes_projects.py`, `routes_settings.py`, `routes_system.py`). GilzaBots'
single 5 000-line `route_api` was not copied. Endpoint **contracts** (paths,
parameters, JSON shapes) are GilzaBots' wherever the reused interface calls
them, so the front-end ports unchanged. Projects moved from
`/api/gilzabots/*` to `/api/projects/*`.

- **Session boundary** (`gilzacode/session.py`, from GilzaBots `local_auth.py`):
  every request must carry this server's own Host, a same-origin (or absent)
  Origin, and `Sec-Fetch-Site` of `none`/`same-origin`; otherwise 403 before
  anything is read. `/api/*` needs the per-process cookie
  (`gilzacode_session_<port>`, HttpOnly, SameSite=Strict, Path=/api/), issued
  by `POST /api/session` with `X-GilzaCode-Bootstrap: 1`. A foreign page cannot
  send that header without a CORS preflight, which is never granted.
- **The bridge's credential.** The MCP bridge is not a browser and cannot hold
  the cookie. The server also accepts `Authorization: Bearer <bridge token>`,
  a second random per-process token written with the URL to
  `~/.gilzacode/connection.json` while the window runs. The file is removed on
  exit, and only by the instance that wrote it.
- **Request ordering** (`app.py: EXCLUSIVE_WORK_PATHS`, from GilzaBots §2.1):
  slow work runs in a worker thread while holding an ordering lock that every
  other request waits on before dispatch. Requests therefore keep arrival
  order, and a save that arrives during a compile lands after it. Streaming
  endpoints are listed in `STREAMING_PATHS` and do not wait.
- **Path confinement** (`gilzacode/files.py`): every path is resolved and
  checked with `os.path.commonpath`, case-insensitively, so a sibling folder
  sharing the prefix (`proj-other`) is outside `proj`. The project root itself
  cannot be deleted, renamed or copied. `/api/file/raw` serves with Range
  support (PDF.js, media). With `sourceTex`, `..` is resolved from the
  including `.tex` file's folder, as LaTeX does.
- **Imports stream to disk.** Multipart parts are read in chunks, never
  buffered whole. Filenames arrive as raw UTF-8, as Chromium sends them.
- **Static interface**: `gilzacode/static/`, with a single-page-application
  fallback. Unknown `/api/*` paths are JSON 404s, never the HTML shell.

## 4. Global data (`~/.gilzacode`, or `GILZACODE_HOME`)

- `settings.json`: language, interface scale, workspace options, the last
  project, and `client_prefs`. The interface's preferences are stored here,
  not in localStorage, because the port (and so the page origin and its
  localStorage) can change between launches (GilzaBots §2.1).
- `projects.json`: the project registry. A project is a name and a folder.
  A registry that cannot be read is reported and never overwritten. Removing a
  project never deletes its folder unless `delete_dir` is requested.
- `connection.json`: see §3.
- `webview/`: the WebView2 profile.
- Writes are atomic (temporary file + `os.replace`).

## 5. The window (`gilzacode/window/webview2.py`, `gilzacode/launcher.py`)

Ported from GilzaBots §2.16.3:

- pywebview's `edgechromium` backend.
- The runtime check refuses to fall back to MSHTML.
- Microphone and camera are granted and everything else is denied.
- Full screen follows the page (presentation mode).
- A dead renderer is reloaded once. After that, or when the browser process
  dies, a dialog offers a restart.

The server runs on its own event loop in a daemon thread, because the main
thread belongs to the window. The port is the first free one from 3100.
`--browser` opens the interface in the default browser for development.

## 6. Roadmap

1. **Window and core server** — done: session boundary, files, projects,
   settings, clipboard, WebView2 window, connection file.
2. **Interface**: copy GilzaBots' `gui_src`. Keep the explorer, editors
   (Monaco, Rich Text, WYSIWYG), PDF viewer with context menus, annotations
   and presentation mode, Markdown preview, LaTeX snippets, the terminal and
   Git. Remove chat, agents, models, cloud, monitors, connectors, skills,
   onboarding and tutorial. Port the LaTeX/Tectonic, SyncTeX, PDF annotation,
   Git, terminal and speech endpoints.
3. **Claude Code integration**: the integrated terminal launches `claude`
   with the bridge configured. "Ask about" pastes into the PTY. Translate and
   Look up call `claude -p`.
4. **MCP tools**: editor state and selection, PDF selection and page, open a
   file at a line, compile LaTeX, SyncTeX forward/inverse, PDF annotations.
   Optional channel.

## 7. Tests

`python -m pytest`. Server tests run a real aiohttp server on a port that
matches its session, since Host is checked, and every test gets its own
`GILZACODE_HOME`. The import test sends the multipart body exactly as Chromium
does. The WebView2 tests are GilzaBots', adapted. The launcher test starts the
real background server and authenticates with the bridge token from the
connection file.
