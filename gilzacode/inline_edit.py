"""Inline edits: Refine, Generate content and Create illustration, written straight into the editor.

GilzaBots' inline actions, restored. The editor asks for an instruction in
place; Claude Code answers headless (``claude -p``) with no tools, the whole
context in the prompt, and the interface writes the answer into the open
editor — replacing the selection (Refine, or a Ctrl+L prompt over a selection)
or inserting at the cursor (Generate, or a Ctrl+L prompt without one). The
edit lands in the editor's buffer, unsaved, so Ctrl+Z takes it back; nothing
goes through the Claude Code panel.

Create illustration asks for an SVG of the selected text. It is saved under
``illustrations/`` at the project root, with a PDF copy beside it when the
file is a ``.tex`` (``\\includegraphics`` takes the PDF), and the interface
inserts a reference to it below the selection.

The answer comes through ``--json-schema``, so it is the content itself, never
a reply to be cut out of Markdown fences.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

from gilzacode import settings
from gilzacode.claude_cli import run_headless
from gilzacode.files import PathOutsideProject, normalize_rel, resolve
from gilzacode.snippets import DEFAULT_LOOKUP_MODEL

#: Replace the selection, insert at the cursor, or create an illustration.
ACTIONS = ("replace", "insert", "illustrate")
MAX_INSTRUCTION_CHARS = 4000
#: The file around the selection travels in the prompt; a larger buffer is refused.
MAX_CONTEXT_CHARS = 400_000
ILLUSTRATIONS_DIR = "illustrations"
TIMEOUT_SECONDS = 300

TEXT_SCHEMA: dict = {
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
    "additionalProperties": False,
}

SVG_SCHEMA: dict = {
    "type": "object",
    "properties": {"svg": {"type": "string"}},
    "required": ["svg"],
    "additionalProperties": False,
}

EDIT_SYSTEM_PROMPT = (
    "You are a precise inline content editor for any selected content: text, Markdown, LaTeX, code, "
    "config files, JSON, YAML, tables, or structured data. "
    "All necessary context is already included in the user prompt; you have no tools and need none. "
    "Answer with the structured output only. Its `text` is the final replacement source exactly as it "
    "must appear in the file: no Markdown fence or other envelope around it, even when it is code or "
    "LaTeX, and no greetings, explanations, comments or summaries. "
    "Preserve the original language, format, structure, and intent unless the requested edit requires "
    "changes. "
    "For insertion tasks, the host application owns the cursor position. The <cursor> tag is "
    "authoritative metadata: use the surrounding content only for context, and never count lines, "
    "choose another insertion point, or reproduce the file. "
    "Be objective, concise, and direct."
)

SVG_SYSTEM_PROMPT = (
    "You are a professional designer and SVG illustrator. Your task is to create a beautiful, clean, "
    "modern and valid SVG illustration that visually represents the text selected by the user. "
    "Answer with the structured output only. Its `svg` is the raw SVG document: it starts with <svg "
    "and ends with </svg>, with no Markdown fence, comments or text around it. "
    "The SVG must be valid and self-contained (no external images, fonts or scripts), with viewBox, "
    "width and height attributes so it renders well on its own. "
    "Use a modern, appealing colour scheme."
)


class InlineEditError(ValueError):
    """A request that cannot be served; ``code`` classifies it for the interface."""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Request:
    project: str
    file: str
    action: str
    instruction: str
    before: str
    selection: str
    after: str
    line: int
    column: int

    @classmethod
    def from_payload(cls, data: dict) -> "Request":
        project = str(data.get("projectPath") or "").strip()
        file = normalize_rel(str(data.get("file") or "").strip())
        action = str(data.get("action") or "")
        instruction = str(data.get("instruction") or "").strip()
        texts = {key: data.get(key) if data.get(key) is not None else "" for key in ("before", "selection", "after")}
        if not project or not os.path.isdir(project):
            raise InlineEditError("The project folder does not exist.", "invalid")
        if not file:
            raise InlineEditError("The file is required.", "invalid")
        try:
            resolve(project, file, allow_root=False)
        except PathOutsideProject:
            raise InlineEditError(f"{file} is outside the project.", "invalid") from None
        if action not in ACTIONS:
            raise InlineEditError(f"Unknown action {action!r}; expected one of {', '.join(ACTIONS)}.", "invalid")
        if not instruction:
            raise InlineEditError("Describe what to do.", "invalid")
        if len(instruction) > MAX_INSTRUCTION_CHARS:
            raise InlineEditError(f"The instruction is longer than {MAX_INSTRUCTION_CHARS} characters.", "invalid")
        if not all(isinstance(value, str) for value in texts.values()):
            raise InlineEditError("before, selection and after must be text.", "invalid")
        if action in ("replace", "illustrate") and not texts["selection"].strip():
            raise InlineEditError("Select the text first.", "invalid")
        if action == "insert" and texts["selection"]:
            raise InlineEditError("An insertion has no selection.", "invalid")
        if sum(len(value) for value in texts.values()) > MAX_CONTEXT_CHARS:
            raise InlineEditError(f"The file is larger than {MAX_CONTEXT_CHARS} characters, the most an inline "
                                  "edit sends.", "too_large")
        line, column = data.get("line"), data.get("column")
        return cls(project, file, action, instruction, texts["before"], texts["selection"], texts["after"],
                   line if isinstance(line, int) and line > 0 else 1,
                   column if isinstance(column, int) and column > 0 else 1)


def resolve_model(requested: str = "") -> str:
    """The request's model, else ``inline_edit_model``, else the Look up model."""
    if requested:
        return requested
    cfg = settings.load()
    return str(cfg.get("inline_edit_model") or cfg.get("lookup_model") or DEFAULT_LOOKUP_MODEL)


def _fence(text: str) -> str:
    """A backtick fence longer than any run of backticks in ``text``."""
    longest = 0
    run = 0
    for char in text:
        run = run + 1 if char == "`" else 0
        longest = max(longest, run)
    return "`" * max(3, longest + 1)


def build_prompt(req: Request) -> str:
    if req.action == "illustrate":
        return f'Selected text to illustrate:\n"""\n{req.selection}\n"""\n\nUser instruction:\n{req.instruction}'
    if req.action == "replace":
        content = req.before + req.selection + req.after
        fence = _fence(content)
        return (f"Task: {req.instruction}\n\n"
                f"File context ({req.file}):\n{fence}\n{content}\n{fence}\n\n"
                f"Target selection to replace (line {req.line}):\n{fence}\n{req.selection}\n{fence}\n\n"
                "Answer with the text that replaces the target selection.")
    return (f"Task: {req.instruction}\n\n"
            "The following is read-only context. The <cursor> tag is application metadata, not source "
            "content. It marks the exact insertion point; generate only the requested snippet for that point.\n\n"
            f"<file_context file=\"{req.file}\">\n<before_cursor>\n{req.before}\n</before_cursor>\n"
            f"<cursor line=\"{req.line}\" column=\"{req.column}\" />\n"
            f"<after_cursor>\n{req.after}\n</after_cursor>\n</file_context>")


def _svg_from(structured: dict | None) -> str:
    svg = str((structured or {}).get("svg") or "").strip()
    if svg.startswith("<?xml"):
        svg = svg[svg.find("?>") + 2:].lstrip()
    if not svg.startswith("<svg") or not svg.endswith("</svg>"):
        raise InlineEditError("Claude Code did not answer with an SVG document.", "invalid_answer")
    return svg


def svg_to_pdf(svg: str) -> bytes:
    """The SVG as a one-page PDF (PyMuPDF), for ``\\includegraphics``."""
    import pymupdf

    try:
        with pymupdf.open(stream=svg.encode("utf-8"), filetype="svg") as doc:
            return doc.convert_to_pdf()
    except Exception as exc:  # PyMuPDF raises its own error types for malformed SVG
        raise InlineEditError(f"The SVG Claude Code drew could not be converted to PDF: {exc}",
                              "invalid_answer") from exc


def save_illustration(project: str, file: str, svg: str) -> dict:
    """Write ``illustrations/illustration_<time>.svg`` (and ``.pdf`` for a ``.tex``); return the paths."""
    pdf = svg_to_pdf(svg) if file.lower().endswith(".tex") else None
    folder = os.path.join(project, ILLUSTRATIONS_DIR)
    os.makedirs(folder, exist_ok=True)
    stem = f"illustration_{time.strftime('%Y%m%d_%H%M%S')}"
    name, n = stem, 1
    while any(os.path.exists(os.path.join(folder, name + ext)) for ext in (".svg", ".pdf")):
        n += 1
        name = f"{stem}_{n}"
    try:
        with open(os.path.join(folder, name + ".svg"), "w", encoding="utf-8", newline="") as handle:
            handle.write(svg)
        if pdf is not None:
            with open(os.path.join(folder, name + ".pdf"), "wb") as handle:
                handle.write(pdf)
    except OSError as exc:
        raise InlineEditError(f"Could not save the illustration: {exc}", "write_failed") from exc
    base = f"{ILLUSTRATIONS_DIR}/{name}"
    return {"svg_path": base + ".svg", "pdf_path": base + ".pdf" if pdf is not None else None}


async def run(req: Request, *, model: str = "") -> dict:
    """Ask Claude Code for the edit; ``{text}`` to write into the editor, or the illustration's paths."""
    illustrate = req.action == "illustrate"
    result = await run_headless(
        build_prompt(req),
        system_prompt=SVG_SYSTEM_PROMPT if illustrate else EDIT_SYSTEM_PROMPT,
        model=resolve_model(model),
        tools=(),
        cwd=req.project,
        timeout=TIMEOUT_SECONDS,
        json_schema=SVG_SCHEMA if illustrate else TEXT_SCHEMA,
    )
    if illustrate:
        return save_illustration(req.project, req.file, _svg_from(result.structured))
    text = (result.structured or {}).get("text")
    if not isinstance(text, str) or not text.strip():
        raise InlineEditError("Claude Code answered without any content.", "invalid_answer")
    return {"text": text}
