# General Rules

0. **MANDATORY**: At the start of a new session in this project, read [PROJECT_DESIGN.md](./PROJECT_DESIGN.md) before doing project work. Within the same session, re-read it only when the task touches architecture or the design may have changed.

0.1. When making architectural or project-design changes, update [PROJECT_DESIGN.md](./PROJECT_DESIGN.md) in the same change.

1. Don't make baseless assumptions; test and analyse before drawing conclusions.

1.1. No kludges, ad hoc semantic fallbacks or hidden behaviour substitutions without explicit user authorization. Preserve contracts, fail fast with a clear diagnostic, and ask before introducing compatibility hacks.

1.2. **Do not remove or replace intended functionality to make an error disappear.** A bug report authorizes repairing the existing behaviour, not choosing a different one. Mocked tests that confirm a replacement is invoked do not demonstrate that the original problem is solved.

2. GilzaCode was started from GilzaBots (`../GilzaBots`) by **copying** modules, never by sharing or importing them. GilzaBots must not be modified for GilzaCode's sake.

3. The agent is **Claude Code**. GilzaCode contains no agent loop and calls no model API directly. One-off model calls (Translate, Look up) go through the `claude` CLI in headless mode.

4. Never patch genuinely external dependencies (anything under `site-packages`) without explicit user authorization.

# Project Guide

## Language
All code, comments and documentation are in **English**. User-facing strings in the interface go through i18n (`t()`) with English as the default value.

## Build & Test

```powershell
.venv\Scripts\python.exe -m pytest        # run after every change
.venv\Scripts\python.exe -m gilzacode     # open the window

# the interface (gui/): lint must report no errors; the build writes gilzacode/static
cd gui; npx eslint src; npm run test:wysiwyg; npm run build
```
