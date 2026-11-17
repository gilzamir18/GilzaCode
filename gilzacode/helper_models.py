"""The Claude model each helper task runs on.

Helper tasks are the one-off ``claude -p`` calls the context menus start:
Translate, Look up, Change .tex and the editor's inline edits (Refine, Generate
content, Create illustration, Ctrl+L). Each has its own setting in
``settings.json``, chosen in Settings > General > Helper tasks. Translate and
Look up have a default model; Change .tex and inline edits follow Look up's
model until they are given one of their own.

A setting holds a Claude Code model alias. With the Ollama provider
(``model_provider.py``) the aliases are mapped to the chosen Ollama models:
``haiku`` to the fast model, the others to the main model.
"""

from __future__ import annotations

from typing import Any

from gilzacode import settings

#: The aliases ``claude --model`` takes for the latest model of each kind.
ALIASES = ("haiku", "sonnet", "opus", "fable")

#: Each task's setting, and its default: a model alias, or the task it follows.
TASKS: dict[str, dict[str, str]] = {
    "translate_model": {"default": "haiku"},
    "lookup_model": {"default": "sonnet"},
    "tex_change_model": {"follows": "lookup_model"},
    "inline_edit_model": {"follows": "lookup_model"},
}


def stored(cfg: dict[str, Any] | None = None) -> dict[str, str]:
    """Each task's own setting; "" when it has none."""
    cfg = settings.load() if cfg is None else cfg
    return {task: str(cfg.get(task) or "") for task in TASKS}


def model_for(task: str, requested: str = "") -> str:
    """The model `task` runs on: the request's, else its setting, else its default."""
    if requested:
        return requested
    own = stored()
    while True:
        if own[task]:
            return own[task]
        spec = TASKS[task]
        if "default" in spec:
            return spec["default"]
        task = spec["follows"]


def save(changes: Any) -> dict[str, str]:
    """Store ``{task: alias or ""}``; "" goes back to the default. Raises ValueError."""
    if not isinstance(changes, dict):
        raise ValueError("The helper models must be an object")
    unknown = sorted(set(changes) - set(TASKS))
    if unknown:
        raise ValueError(f"Unknown helper tasks: {', '.join(unknown)}")
    for task, value in changes.items():
        if value != "" and value not in ALIASES:
            raise ValueError(f"{task} must be one of {', '.join(ALIASES)}, or empty for the default")
    return stored(settings.save(dict(changes)))


def describe() -> dict[str, Any]:
    """What Settings shows: the stored choices, the defaults and the aliases."""
    return {"models": stored(), "tasks": TASKS, "aliases": list(ALIASES)}
