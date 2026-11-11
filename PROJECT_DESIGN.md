# GilzaCode Project Design

GilzaCode is a desktop workspace for reading and writing, on Windows and Linux: PDF with
AI-assisted reading, LaTeX with compile/preview/SyncTeX, Rich Text and WYSIWYG
editing, Markdown. It reuses the **interface** of GilzaBots and replaces GilzaBots'
own agent with **Claude Code**, connected through an MCP server of the
application. GilzaBots is unchanged; GilzaCode copies what it needs from it.

---

## 1. Architecture

```
GilzaCode.exe (pywebview + WebView2)      Linux: GilzaCode (pywebview + QtWebEngine)
 ├─ Interface: React/Vite, reused from GilzaBots' gui_src (phase 2)
 ├─ Loopback server (aiohttp): files, projects, settings, clipboard,
 │    LaTeX/Tectonic, SyncTeX, PDF annotations, Git, terminal PTY, speech,
 │    cloud sync (Google Drive)
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
  project never deletes its folder unless `delete_dir` is requested. Deleting
  the folder first closes the terminal sessions started in it (shell tabs and
  Claude Code, `routes_terminal.close_sessions_in`), with no await between that
  and the deletion: Windows refuses to delete a folder that is a process'
  working directory (`WinError 32`). Closing the PTY also ends the programs
  started from it.
- `connection.json`: see §3.
- `webview/`: the browser profile (WebView2 on Windows, QtWebEngine on Linux).
- Writes are atomic (temporary file + `os.replace`).

## 5. The window (`gilzacode/window/webview2.py`, `gilzacode/launcher.py`)

Ported from GilzaBots §2.16.3:

- pywebview's `edgechromium` backend.
- The runtime check refuses to fall back to MSHTML.
- Microphone and camera are granted and everything else is denied.
- Full screen follows the page (presentation mode).
- A dead renderer is reloaded once. After that, or when the browser process
  dies, a dialog offers a restart.
- **One browser profile per user** (`<gilzacode home>/webview`). A second
  window started with different WebView2 options while another holds the
  profile (e.g. a development run with other browser arguments) cannot
  initialise: WebView2 answers `0x8007139F`. That case gets its own message
  ("another GilzaCode window is using the same browser profile; close it"),
  with no restart offered, because a restart hits the same conflict. It used to
  show the generic dialog, whose *Restart* looped.

The server runs on its own event loop in a daemon thread, because the main
thread belongs to the window. The port is the first free one from 3100.
`--browser` opens the interface in the default browser for development.

### 5.1 Linux: QtWebEngine (`gilzacode/window/qt.py`)

GilzaBots' window is QtWebEngine on Linux (its §2.16.1). GilzaCode takes the
same engine and the same verified Qt range, adapted the way the Windows window
was. Windows is untouched: it never imports this module, and its dependencies
carry no Qt.

- **pywebview's Qt backend, not patched.** GilzaBots monkey-patched pywebview's
  Qt classes. Here, as for WebView2, the handlers are connected in pywebview's
  `before_show`. It runs synchronously on the UI thread, after the page and its
  profile exist and before the window is shown. The handlers:
  - permissions: microphone and camera granted, everything else denied
    (`permissionRequested`). pywebview's own handler passes plain integers to
    `setFeaturePermission`, which PyQt6 refuses, so it is disconnected;
  - full screen: the page's request is accepted and the window follows. This
    needs `FullScreenSupportEnabled`; GilzaBots' QtWebEngine refused
    presentation mode;
  - `window.print()`: saved as a PDF the user names (GilzaBots);
  - downloads: saved where the user chooses, starting in Downloads. pywebview's
    handler uses a Qt 5 API;
  - a dead renderer: reloaded once, then the user is offered a restart. This
    is `webview2.failure_action`, shared with Windows.
- **No `webview.screens` before `webview.start` on Linux.** It initialises
  pywebview without a backend, which on Linux tries GTK first and imports the
  Qt backend early enough to fix its profile in `~/.pywebview`. That is where
  GilzaBots' Qt profile ended up. The window is sized in `before_show` from Qt's
  own screen, with the same 80 % rule as Windows (`launcher.size_for_screen`).
  The profile is in `<gilzacode home>/webview`.
- **Refusals instead of worse failures** (`require_runtime`). Asked for
  `gui="qt"`, pywebview silently falls back to GTK (WebKitGTK) when Qt does not
  load; that is reported instead. As root, Chromium aborts its zygote ("Running
  as root without --no-sandbox is not supported") and no window appears; that
  is refused with a reason, unless the user turned the sandbox off with
  QtWebEngine's own switches.
- **Graphics: GPU off by default** (`apply_environment`), as in GilzaBots on
  Linux. QtWebEngine runs its GPU service inside this process, and Mesa's
  Zink/EGL can abort at startup without a DRM render node. The setting is
  `--disable-gpu` plus `QT_QUICK_BACKEND=software`; the flag alone still
  composites through the driver. `GILZACODE_DISABLE_GPU=0` turns the GPU on for
  one run, and any other value is refused. GilzaBots' Settings toggle is not
  ported: GilzaCode dropped the window-graphics section (§7). A restart gets
  the environment from before this run (`pristine_environment`), so the flags
  pywebview appends do not pile up.
- **Clipboard** (`gilzacode/qt_clipboard.py`). The front-end sends clipboard
  calls to `/api/clipboard/*` on every platform. On Linux the window's
  `QClipboard` answers, on the UI thread (`run_on_ui_thread`), and it serves X11
  and Wayland. GilzaBots' fallback, a throwaway `QApplication` in a
  `sys.executable -c` subprocess, cannot work in a frozen build and is not
  copied. With `--browser` there is no clipboard, and the request says so.
- **Opening files and links** (`gilzacode/desktop.py`): `xdg-open`, watched for
  1.5 s for an early failure (GilzaBots). Web links and the Google sign-in also
  go through it on Linux, not `webbrowser`, for the reason in §10.
- **The terminal** is bash in a PTY (the POSIX path copied from GilzaBots).
- **Verified** with `scripts/smoke_linux_window.py`, which opens the real window
  with QtWebEngine's remote debugging and checks it through the DevTools
  protocol. It checks that the interface renders, the Qt clipboard round-trips,
  full screen is accepted, geolocation is denied, the terminal's shell gets the
  user's `LD_LIBRARY_PATH`, the profile is in `<gilzacode home>/webview`, and no
  renderer died. Run under WSLg (Ubuntu 26.04) on X11 and Wayland, from source
  and from the installed bundle.

## 6. Document features (`gilzacode/latex_compiler.py`, `synctex_parser.py`, `pdf_annotations.py`, `git_repo.py`, `terminal_manager.py`, `speech/`)

The modules are GilzaBots' and AgenticBlocks', copied with their names
changed. Their own tests came with them. The routes are new.

- **LaTeX** (`routes_latex.py`): compile (full, draft, partial with a full
  fallback), recompile a standalone PDF from its `.tex`, TikZ and include
  previews, DOCX export through pandoc, SyncTeX in both directions, artifact
  cleaning, and installing Tectonic and pandoc into `<gilzacode home>/bin`.
  Compiles are exclusive work. The main file comes from the request, then the
  project registry, then the compiler's own detection. Each compile's routing
  decision is written to `<project>/.gilzacode/latex_compile_debug.json`.
- **PDF annotations** (`routes_pdf.py`): stored inside the PDF itself, so they
  interoperate with other readers. Writes are exclusive work in a thread, so
  two edits never rewrite the same file at once.
- **Git** (`routes_git.py`, `git_repo.py`): status, diff, log, stage, discard,
  commit and file-at-HEAD, against the user's repository or a Git root inside
  the project. GilzaBots' agent checkpoint history ("shadow" repository,
  review layout, restore/archive) is not ported. A request for it is refused
  with a pointer to Claude Code's `/rewind`, not served from the user's
  repository.
- **Terminal** (`routes_terminal.py`): one winpty PowerShell (Linux: bash in a
  PTY) per bottom-panel tab, streamed over SSE with the stream offset as the event id, so a
  reconnecting client receives only what it missed. `/api/terminal/output` is
  read-only, for the MCP tools.
- **Restart without CREATE_NEW_PROCESS_GROUP** (`launcher.spawn_detached`).
  That flag disables Ctrl+C in the new process and in everything it starts,
  which would include the integrated terminal and Claude Code in it. GilzaBots
  found and fixed this; GilzaCode's first launcher had reintroduced it.
- **Pronounce** (`speech/`, `routes_speech.py`): a downloaded Piper voice run
  in-process, with phonemes from the system espeak-ng. GilzaBots' "remote"
  engine called an OpenAI-compatible endpoint through litellm and its model
  store. It is not offered, because GilzaCode makes no model API calls of its
  own, and a request for it is refused.

## 7. The interface (`gui/`, built into `gilzacode/static/`)

GilzaBots' `gui_src`, cut down. `npm run build` writes the bundle into the
package. ESLint (`no-undef`) is part of the toolchain because JavaScript only
reports a dangling name when the line runs; the cut was driven by it.

- **Removed**: chat and chat list, agent runs and their windows (plan review,
  ask, interactive command), slash commands, models, providers and
  connections, hardware, monitors, MCP connectors, asset store,
  onboarding, tutorial, dictation, the Agent Thinking tab, agent change
  badges, and the `chat-bottom` and `review` layouts. Settings lost the
  agent sections (reasoning size, prompt evolution, image generation, Docker
  sandbox, data folder, ephemeral parameters) and the window-graphics,
  feedback and uninstall sections, which referred to GilzaBots.
- **Product**: GilzaCode is free, with no account and no subscription; the only
  requirement is Claude Code. Settings > About keeps GilzaBots' donation card
  (the same PayPal link and QR code), with GilzaCode's wording. No license is
  stated yet, so nothing claims the project is open source.
- **Layouts**: `ide`, `chat`, `studio`, `document`. The chat layout is
  GilzaBots' chat layout with Claude Code as the conversation: the panel
  across the centre, the explorer docked left (`layoutDocksSidebar`), no
  editor or bottom panel. Opening a file goes to `ide`; the panel's close
  button leaves the layout. Switching between `ide` and `chat` keeps the same
  panel element, so the Claude Code session and its screen survive. GilzaBots'
  chat list has no counterpart: Claude Code's own `/resume` lists sessions.
- **The chat's place is the Claude Code panel** (`components/ClaudePanel.jsx`):
  same column, same Ctrl+T, same studio cell. Document actions hand it text
  through one state (`claudePromptRequest`): *Ask about* (PDF, Markdown),
  *Fix with AI* (LaTeX errors) and the editor's inline prompts (Ctrl+L,
  Refine, Generate, Create illustration). In phase 2 the panel shows the text;
  in phase 3 it pastes it into Claude Code's composer, unsent.
- **Behaviour changes**: *Fix with AI* and the inline prompts used to run
  GilzaBots' agent at once (a new chat, or a replaced selection). They now
  stage a request the user sends, and Claude Code edits the files itself.
- **Projects** use `/api/projects/*`, with a project's settings (name,
  folder, main file, Git root, compile on save) saved through
  `/api/projects/update`. Unknown or mistyped fields are refused.
- **Preferences** keep GilzaBots' one-time localStorage import, which never
  overwrites a stored key.
- **Fixed from GilzaBots**: a ` ```tikzgraphic ` block in rendered Markdown
  threw a ReferenceError (`formatMessage.jsx` read a variable from another
  function's scope).
- **Known leftovers**: some older i18n strings still mention the chat, and
  `GitSidebar.jsx` still carries GilzaBots' inactive review-mode branches.

## 8. Claude Code (`claude_cli.py`, `routes_claude.py`, `snippets.py`, `components/ClaudePanel.jsx`)

### The panel

- **The session** is a PTY with the terminal id `claude` that runs the
  `claude` CLI in the project folder. It is found at `GILZACODE_CLAUDE`, on
  `PATH`, or on Linux in `~/.local/bin`, where Claude Code's installer puts it
  (`claude_cli.installer_locations`). A program started from the desktop menu
  gets the login session's `PATH`, which lacks that folder until the next login
  after it was created. A missing CLI is reported in the panel with what to
  install.
- **Transport:** the panel streams and types through the terminal endpoints,
  so it reuses the bottom panel's xterm component. Opening the panel starts
  the session. Switching projects replaces it.
- **No restart by reconnecting:** an exited session is not restarted by
  reconnecting, as a shell tab is. The stream answers 410, and the panel
  offers to start it again (`/api/claude/start`).
- **An exit is announced.** When Claude Code exits by itself (`/exit`), its
  stream ends with an SSE `ended` event after the last output. The panel closes
  the EventSource and shows that Claude Code ended at once. Before, it learnt
  this only from the reconnect EventSource makes about 3 s later, and showed
  "connection lost" meanwhile. A session closed by the server (a restart, a
  project switch, a deleted folder) sends no `ended`
  (`TerminalSession.ended_by_itself`), so a stale stream cannot report a
  session that was just replaced as ended.
- **A real drop is shown as waiting, not as an error.** The shell tabs write
  "connection lost" into the terminal. The panel passes `onConnectionChange`
  to the terminal hook instead and covers the terminal with a "waiting for
  Claude Code to reconnect" card until the stream reopens or ends.
- **No Enter on show.** The shell tabs send one Enter the first time they are
  shown, to redraw the prompt. The panel turns that off
  (`redrawPromptOnShow`), because in Claude Code it would answer the folder
  trust dialog of a first run. Verified in the window: an untrusted folder
  shows the dialog, and it stays untouched.
- **Nested-session markers are dropped.** `CLAUDECODE`,
  `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_CHILD_SESSION` are removed from the
  child's environment: GilzaCode's Claude is not a child of whichever Claude
  session launched GilzaCode.

### Staged prompts are pasted, never submitted

*Ask about*, *Fix with AI* and the inline prompts reach the panel as
`promptRequest`.

- **The paste:** the text goes in as one bracketed paste
  (`/api/claude/paste`). Every ESC is removed first, because a PDF excerpt
  carrying `ESC[201~` could otherwise end the paste and type the rest,
  Enter included. Newlines become `\r`, as a terminal pastes them.
- **When it happens on its own:** only into a session that has been running
  for at least 5 s and whose output has been quiet for 0.6 s. Otherwise
  (just started, busy, ended) the prompt stays visible in the panel with
  *Paste into Claude Code* and *Discard*.
- **Verified in the window:** the text lands in Claude Code's composer and is
  not sent.

### Translate and Look up (`claude -p`)

- **Prompts:** GilzaBots' system prompts, same HTTP contracts.
- **Input on stdin.** An excerpt can be 20 000 characters, and the Windows
  command line is limited.
- **Isolated calls:** each call uses `--strict-mcp-config`,
  `--no-session-persistence` and `--setting-sources ""`.
- **Tools:** Translate gets none. Look up gets `Read,Grep,Glob` with the
  project as its working directory.
- **Files read:** `--output-format stream-json` reports the Read calls, which
  become `files_read`.
- **Models:** `haiku` for Translate and `sonnet` for Look up by default, in
  the `translate_model` / `lookup_model` settings.
- **Measured:** about 2.5 s per translation and about 6.5 s for a Look up
  that read a file.
- **Errors:** a missing CLI answers 503, a timeout 504, and a model-reported
  error 502, each with its message.

### Known limitation

`/api/terminal/output` turns raw PTY bytes into text with a line-oriented
filter (`screen_text`). That fits a shell, but not a full-screen TUI that
moves its cursor. Claude Code's screen comes out garbled. An MCP tool that
reads the panel needs a real terminal emulator (e.g. pyte).

### MCP tools (`mcp_bridge.py`, `ide_control.py`, `routes_ide.py`, `utils/ideCommands.js`)

**The bridge.** `gilzacode-mcp` (`python -m gilzacode.mcp_bridge`) is the MCP
server Claude Code starts over stdio.

- **Where it comes from:** the panel launches `claude --mcp-config
  <gilzacode home>/mcp-config.json`, which adds it to the user's own MCP
  servers. `GILZACODE_PROJECT` names the project folder.
- **Protocol:** the JSON-RPC is hand-written. It refuses `server/discover` and
  answers `initialize` with a handshake revision (§2).
- **Reaching the app:** each tool is one call to the app's local API with the
  bridge token from `connection.json`, read again on every call, so a
  restarted app is found. Tool calls run in threads, so a compile does not
  hold up the others.

**The window answers for itself.** Tools that read or drive the window are
commands put on `/api/ide/events`. The window performs them with the same
handlers a click uses (`ideCommands.js`, the runner GilzaBots' agent used) and
posts the result to `/api/ide/result`.

- **A refusal is an answer:** another project on screen, a file with unsaved
  edits, no PDF shown. The tool fails with the window's reason, written for
  the model.
- **No answer:** without a listening window a command fails at once; an
  unanswered one fails after 15 s.

**The tools:**

| Tool | What it does |
|---|---|
| `get_editor_state` | project, tabs, focused file, cursor, selection (≤ 20 000 chars), unsaved tabs |
| `get_pdf_view` | the PDF shown, page, page count, the last text selected in it |
| `open_file` | path, optional line, optional background tab |
| `close_file` | refused when the tab has unsaved edits |
| `reveal_in_pdf` | SyncTeX forward search for a `.tex` line |
| `set_layout` | `ide`, `studio` or `document` |
| `get_problems` | the Problems panel |
| `compile_latex` | `/api/ide/compile`: compiles the `.tex` as saved on disk through the same `run_compile` as the editor's button, then publishes `latex_compiled`, so the PDF pane refreshes or shows the error |
| `list_pdf_annotations` | the annotations stored in a PDF |

- **Selection memory:** the PDF viewer remembers the last non-empty selection
  made in it, because clicking into Claude Code's terminal can clear the
  document selection before the model reads it.
- **Permissions:** the read-only and display-only tools are passed to
  `--allowedTools`, so Claude Code uses them without asking. `compile_latex`
  writes files (PDF, auxiliaries) and asks.
- **Verified with the real Claude Code** in the panel: it called
  `get_editor_state` (README.md focused), then `open_file` for CLAUDE.md
  line 3, and the window switched to that tab at that line.
- **Not done:** the optional channel (§2). Packaging must give the bridge a
  command that works in a frozen build: today it is `sys.executable -m
  gilzacode.mcp_bridge`.

## 9. Cloud sync (`gilzacode/cloud/`, `server/routes_cloud.py`)

Ported from GilzaBots' cloud sync, **without the conversation export**:
GilzaBots mirrored each project's chats through `.gilzabots/session/chats.json`
and the mobile app's device journals. GilzaCode has no conversations of its own
(Claude Code keeps its sessions outside the project), so `chats.py`, the
journals and the `include_chats` setting are gone.

**What is unchanged from GilzaBots:**
- the three-way engine (`engine.py`) against a per-project baseline
  (`.gilzacode/cloud/state.json`), with conflict copies, a refusal to delete a
  large share of the working copy without confirmation, and cancellation that
  keeps what already moved;
- the providers: Google Drive (`drive.file` scope, PKCE loopback OAuth,
  stdlib-only) and `local_folder`, the offline provider the tests use;
- the scanner's exclusions (`.env` unless opted in, `node_modules`, the sync's
  own state), plus GilzaCode's `.gilzacode/latex_compile_debug.json`, which
  holds absolute paths of one machine;
- cloning a mirrored project onto another machine, and deleting the cloud copy
  together with the project.

**What changed:**
- **A local watch.** GilzaBots announced every write from its own endpoints and
  had no filesystem watcher. In GilzaCode most edits come from Claude Code,
  which writes straight to disk where no endpoint sees them. Each synced
  project therefore also gets a stat-only walk every `LOCAL_WATCH_SECONDS`
  (10 s): it compares paths, sizes and mtimes of the sync set (excluded files
  never count) and announces a change through the same debounced trigger. It
  announces changes seen while a pass runs too, since the edit may have landed
  after that pass scanned. The file endpoints still announce their own writes,
  so an editor save does not wait for the walk.
- **Projects** are GilzaCode's JSON registry: a clone registers the folder
  through `projects.add`, the delete endpoint is `/api/projects/delete` with
  `delete_cloud`, and "already mirrored here" is read from that registry.
- **Names:** Drive mirrors live under a `GilzaCode` folder (GilzaBots used
  `GilzaBots`, so projects mirrored by GilzaBots are not listed), credentials in
  `<home>/cloud`, the environment override is `GILZACODE_GDRIVE_CLIENT_ID` /
  `GILZACODE_GDRIVE_CLIENT_SECRET`.

**The Google OAuth client.** A build normally embeds a "Desktop app" client
(`gilzacode/cloud/providers/bundled_google_client.json`, git-ignored), so the
user only presses Connect. `scripts/embed_google_client.py` writes it from the
environment, from arguments, or from the JSON the Google Cloud console
downloads; `build_exe.ps1` runs it when `GILZACODE_GDRIVE_CLIENT_ID` is set and
the spec bundles the file when it exists. The script refuses an id that does not end with
`.apps.googleusercontent.com` (or that is the secret, `GOCSPX-…`): a release
once shipped the secret in both fields and every Connect got `401 invalid_client`. A build without it still works: the
panel asks for a user-supplied client. The client secret of a desktop client is
not confidential (Google's own guidance), but it is kept out of the repository
anyway.

**Lifecycle.** `GET /api/cloud/status` is what starts a project's background
sync, as in GilzaBots: the interface asks for it when a project becomes
active. The app's cleanup stops every background task.

**Interface.** GilzaBots' panels are restored without the conversations
toggle: `CloudSyncModal` (activity bar, disabled without a project),
`CloudDownloadModal` (explorer header), the status-bar indicator, the
explorer's per-file badges and the cloud option of the delete dialog.

## 10. Packaging and installation (`build_exe.ps1`, `packaging/`, `install.ps1`, `uninstall.ps1`)

Adapted from GilzaBots' Windows packaging.

**What the build produces.** `build_exe.ps1` builds the interface, downloads
Tectonic 0.15.0 and pandoc 3.10 into `build/tools/bin`, and runs
`packaging/GilzaCode.spec`. The result is `dist/GilzaCode/` and
`dist/GilzaCode-windows-x64.zip`.

**Two executables share one folder:**
- `GilzaCode.exe` (windowed) is the window.
- `gilzacode-mcp.exe` (console) is the MCP bridge. It is a separate console
  executable because Claude Code speaks to it over stdin/stdout, which a
  GUI-subsystem build does not provide reliably.
- In a frozen build, `claude_cli.bridge_command` points the MCP config at
  `gilzacode-mcp.exe` next to the window. If the bridge is missing, it fails
  with "Reinstall GilzaCode" instead of falling back to anything.
- The bridge's analysis excludes the heavy packages (WebView, PyMuPDF,
  ONNX), and Qt is excluded from both, as in GilzaBots.

**The window's entry point** (`packaging/entry_gilzacode.py`) carries
GilzaBots' frozen-build setup:
- UTF-8 streams;
- pythonnet pointed at the bundled Python DLL;
- `winpty-agent.exe` on PATH;
- `CREATE_NO_WINDOW` for children started without flags, so Tectonic or
  `claude -p` do not flash a console.

**The build checks itself:** it fails if the bundled bridge does not answer
`initialize` over stdio.

**Releases** come from `.github/workflows/release.yml`: pushing a `v*` tag
builds on a GitHub Windows runner and attaches `GilzaCode-windows-x64.zip`
to the tag's release, creating it when needed (*Run workflow* rebuilds an
existing tag). It stops when the tag differs from the version in
`pyproject.toml` and `gilzacode/__init__.py`, when the Google client secrets
(`GILZACODE_GDRIVE_CLIENT_ID` / `_SECRET`) are missing, when a test fails, or
when the package lacks the embedded client.

**`install.ps1` installs per user** into `%LOCALAPPDATA%\GilzaCode`, with no
administrator rights.
- **Package source:** `-Source <zip or URL>`, else `GILZACODE_DOWNLOAD_URL`,
  else the latest GitHub release of `gilzamir18/GilzaCode`, once one exists.
- **What it creates:** Desktop and Start-menu shortcuts, an uninstall shortcut,
  and a per-user *Installed apps* entry.
- **What it refuses:** to extract over a running copy.
- **What it checks:** it warns when `claude` is not on PATH (GilzaCode's one
  requirement) or when WebView2 is missing, and installs neither.
- **No PATH entry**, unlike GilzaBots: GilzaCode has no command-line interface.

### 10.1 Linux (`build_exe.sh`, `packaging/GilzaCode-linux.spec`, `install.sh`, `uninstall.sh`)

Supported: Ubuntu 22.04 or newer, x86_64. GilzaBots supports 24.04 and 26.04
and builds on `ubuntu-latest`. GilzaCode builds on the oldest supported release,
because PyInstaller copies the build machine's Python and libraries, and they
need that machine's glibc or a newer one.

**What the build produces.** `build_exe.sh` checks the Qt that will be packaged
(`scripts/check_qt_runtime.py`) and builds the interface. It downloads
Tectonic 0.15.0 (the static musl build, which also serves the in-app install)
and pandoc 3.10, and runs `packaging/GilzaCode-linux.spec`. The result is
`dist/GilzaCode/` (`GilzaCode` and `gilzacode-mcp`) and
`dist/GilzaCode-linux-x64.tar.gz`, about 360 MB. The Windows spec and entry
point are untouched; Linux has its own (`entry_gilzacode_linux.py`).

**The build checks itself**, as on Windows (the bridge must answer
`initialize`), and runs GilzaBots' library gate
(`scripts/check_bundle_libraries.py`). PyInstaller only warns when the build
machine lacks a library, and the bundle then starts only where the user happens
to have it. The gate runs `ldd` on what the window loads and refuses anything
that resolves outside the bundle, except what PyInstaller deliberately leaves to
the host (glibc, the GL/EGL/DRM stack, `libxcb.so.1`, Wayland). In a stock
`ubuntu:22.04` container it refused the first build: QtWebEngineProcess links
libXcomposite, libXdamage, libXrandr, libXtst and libxkbfile, on top of
GilzaBots' nine xcb libraries. The build header and `release.yml` list all of
them.

**libgbm and libstdc++ are left to the system** (`HOST_LIBRARIES` in the spec and
the gate, kept equal by a test). PyInstaller bundles both. Everything in the
bundle comes first on `LD_LIBRARY_PATH`, so the system's Mesa drivers, loaded
into this process, got the 22.04 copies. Each was measured on the bundle built
on 22.04, and removing that one library alone fixed it:
- **libgbm** is Mesa's own and tied to its drivers. Without the fix, the window
  did not open on Ubuntu 26.04, on X11 or Wayland (WSLg) or under Xvfb.
- **libstdc++** is older than a newer Mesa's LLVM needs. Without the fix, the
  window did not open on 24.04 ("Could not initialize GLX"). Removing each of
  the 18 other bundled libraries that Mesa also loads, one at a time, changed
  nothing. The system's libstdc++ always serves the bundle, because the build
  runs on the oldest supported release.

Every desktop has both (`libgbm1`, `libstdc++6`). PyInstaller already leaves
libGL, libEGL and libdrm to the host for the same reason.

**The library path: the app keeps the bundle's, started programs get the
user's** (`subprocess_utils.host_environment`). The bootloader puts the bundle's
`_internal` at the front of `LD_LIBRARY_PATH` and keeps the user's value in
`LD_LIBRARY_PATH_ORIG` (measured with PyInstaller 6.22).
- **The app needs it.** QtWebEngineProcess, which Chromium starts with this
  process's environment, needs it: its RUNPATH reaches only `PyQt6/Qt6/lib`,
  and it links NSS and X libraries the bundle carries in `_internal`.
- **Restoring the user's value globally was tried first, and it was wrong.**
  It passed on a machine with NSS installed. In a container without NSS,
  QtWebEngineProcess failed on `libnspr4.so` and no page appeared.
- **Everything the app starts gets the user's value back.** That covers the
  terminal's bash, Claude Code and `claude -p`, git, Tectonic, pandoc,
  `xdg-open` and the restart. Otherwise they would load the bundle's OpenSSL
  and friends.
- **No `webbrowser` on Linux.** It takes no environment, so links and the Google
  sign-in go through `xdg-open` (`desktop.open_url`).
- **A test keeps it that way.** Every spawn in the package must pass `env=`,
  except the Windows restart, which is unchanged
  (`test_every_started_program_gets_an_explicit_environment`).

**`install.sh`** is `install.ps1` for Linux, per user, with no administrator
rights:
- **Where it installs:** `~/.local/share/GilzaCode`.
- **Package source:** `--source`, then `GILZACODE_DOWNLOAD_URL`, then the latest
  release's `GilzaCode-linux-x64.tar.gz`.
- **Unpacking:** into a staging folder first, so a broken package leaves the
  installed version alone. It refuses to unpack over a running copy (read from
  `/proc/*/exe`).
- **What it creates:** a `gilzacode.desktop` menu entry, matching the window's
  Wayland app id (`setDesktopFileName`).
- **What it checks:** it warns when `claude` is missing. It adds no PATH entry,
  as on Windows.

**`uninstall.sh`** keeps `uninstall.ps1`'s guarantees:
- it refuses while anything runs from the installation;
- files go first;
- only the menu entry that starts this installation is removed;
- global data goes only with `--purge` and a typed confirmation;
- project folders are never touched.

**Releases** (`release.yml`): the windows job is unchanged. Three Linux jobs
follow it:
- **`linux`** builds in an `ubuntu:22.04` container, after the same version and
  secret checks and the same tests. Python 3.12 is python-build-standalone,
  through `setup-uv`.
- **`linux-smoke`** installs the package with `install.sh`, as a normal user, on
  `ubuntu:22.04`, `24.04`, `26.04` and `rolling`. It opens the window under
  Xvfb with `scripts/smoke_linux_window.py`, with Chromium's sandbox on. The
  containers carry what every Ubuntu desktop has (Mesa, Wayland and the base X
  libraries). The jobs were reproduced locally in Docker 29 with its default
  seccomp profile, where all four passed. The GitHub runner itself has not run
  them yet.
- **`linux-release`** attaches `GilzaCode-linux-x64.tar.gz` after the windows
  job, which creates the release.

**`uninstall.ps1`** keeps GilzaBots' guarantees:
- failures are logged and stay on screen;
- it refuses while anything runs from the installation, the bridge included;
- it leaves the folder before deleting it, and retries for antivirus locks;
- files go first, so a failed removal leaves the entry in place to retry;
- only shortcuts that point at this installation are removed;
- the global data goes only with `-Purge` and a typed confirmation;
- project folders are never touched.

## 11. Roadmap

1. **Window and core server** — done.
2. **Interface and document backend** — done. Verified in the real window
   through the DevTools protocol (import a project, open a `.tex` in Monaco,
   install Tectonic, compile, Ctrl+T), with no exception or console error.
3. **Claude Code integration** — done: the panel runs Claude Code, staged
   prompts are pasted unsent, Translate and Look up call `claude -p`.
4. **MCP tools** — done (§8, *MCP tools*).
5. **Packaging** — done (§10).
6. **Cloud sync** — done (§9).
6.1. **Linux** — done: QtWebEngine window (§5.1), package, installer and
   release jobs (§10.1).
7. **Next**: porting GilzaBots' browser suite, the optional channel, a
   terminal emulator for reading the Claude panel, and the leftovers in §7.

## 12. Tests

- `python -m pytest`. Server tests run a real aiohttp server on a port that
  matches its session, since Host is checked, and every test gets its own
  `GILZACODE_HOME`.
- GilzaBots' tests that drove `route_api` run unchanged through
  `tests/legacy_api.py`, which sends their calls as real HTTP requests.
- Terminal tests use a real PowerShell under winpty on Windows
  (`test_terminal_api.py`) and a real bash in a PTY on Linux
  (`test_terminal_api_posix.py`), and Git tests use real repositories.
- The suite runs on Windows and on Linux (the release builds run it on both).
  `test_linux_window.py` covers the Linux window's policies on every platform,
  and a real `QClipboard` where PyQt6 is installed. The real window is checked
  by `scripts/smoke_linux_window.py` (§5.1, §10.1). The import test sends the multipart body exactly as Chromium
  does.
- GilzaBots' browser suite (`gui_src/test/browser`: PDF look-up and translation
  popups, presentation mode, terminal selection, editor file switch) depends on
  GilzaBots' server and is not ported yet; the interface was verified instead
  with DevTools-protocol scripts against the real window (§7, §8).
- `cd gui; npm run test:wysiwyg` runs the copied front-end suites (editor
  round-trips, LaTeX parsing, layouts, preferences). `npx eslint src` must
  report no errors.
- The cloud tests are GilzaBots' (engine, scanner, OAuth, transport, clone,
  cancel, delete, progress, Google client) against `local_folder`, with the
  endpoint tests rewritten for the aiohttp client and the conversation tests
  dropped; `test_cloud_local_watch.py` covers the local watch.
