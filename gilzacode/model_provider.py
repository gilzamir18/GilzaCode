"""Which model service Claude Code uses when GilzaCode starts it.

GilzaCode starts every `claude` process itself (the panel's session, Translate,
Look up, the plugin commands) with the environment from
``claude_cli.child_environment``. The provider is applied there and nowhere
else, so it changes only the processes GilzaCode starts: never a `claude` the
user runs elsewhere, and never the user's own environment variables.

* ``anthropic`` (the default) adds nothing. Claude Code uses whatever the user
  set up: the claude.ai login, or variables of their own.
* ``ollama`` points Claude Code at an Ollama server's Anthropic-compatible API,
  with the variables Ollama documents
  (https://docs.ollama.com/integrations/claude-code): ``ANTHROPIC_BASE_URL``,
  ``ANTHROPIC_AUTH_TOKEN=ollama`` and an empty ``ANTHROPIC_API_KEY``. The bearer
  token ranks above a claude.ai login in Claude Code's authentication order, so
  the login is left in place and is used again once the provider is switched back.

GilzaCode passes model aliases (``--model haiku`` for Translate, ``sonnet`` for
Look up), and Claude Code's own agents use aliases too. Ollama knows its models
by their own names, so each alias is mapped to the chosen model through Claude
Code's ``ANTHROPIC_DEFAULT_<ALIAS>_MODEL`` variables. ``haiku``, the alias for
quick work, maps to the "fast" model when one is chosen.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

KINDS = ("anthropic", "ollama")
DEFAULT_OLLAMA_URL = "http://localhost:11434"

DEFAULTS: dict[str, str] = {
    "kind": "anthropic",
    "ollama_url": DEFAULT_OLLAMA_URL,
    "ollama_model": "",
    "ollama_fast_model": "",
}

#: Set to the main model: the session's model, the larger aliases and subagents.
MAIN_MODEL_VARIABLES = (
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
)
#: Set to the fast model (the main one when none is chosen).
FAST_MODEL_VARIABLES = ("ANTHROPIC_DEFAULT_HAIKU_MODEL",)

MODEL_NAME_MAX_CHARS = 200


def _model_name(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    name = value.strip()
    if len(name) > MODEL_NAME_MAX_CHARS:
        raise ValueError(f"{field} is longer than {MODEL_NAME_MAX_CHARS} characters")
    if any(ch.isspace() or ord(ch) < 32 for ch in name):
        raise ValueError(f"{field} must not contain spaces or control characters")
    return name


def normalize_url(value: Any) -> str:
    """An Ollama server URL: http(s), with a host, no query or fragment; no trailing slash."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("The Ollama URL is required")
    url = value.strip().rstrip("/")
    try:
        parts = urlsplit(url)
        parts.port  # raises ValueError for a port that is not a number
    except ValueError as exc:
        raise ValueError(f"The Ollama URL is not valid: {exc}") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("The Ollama URL must start with http:// or https:// and name a host")
    if parts.query or parts.fragment:
        raise ValueError("The Ollama URL must not have a query or a fragment")
    return url


def normalize(raw: Any) -> dict[str, str]:
    """A complete, valid provider from `raw`; raises ValueError naming what is wrong.

    Missing fields take their defaults. Unknown fields are refused, so a
    misspelled key is reported instead of being silently ignored.
    """
    if not isinstance(raw, dict):
        raise ValueError("The model provider must be an object")
    unknown = sorted(set(raw) - set(DEFAULTS))
    if unknown:
        raise ValueError(f"Unknown model provider fields: {', '.join(unknown)}")
    merged = {**DEFAULTS, **raw}
    kind = merged["kind"]
    if kind not in KINDS:
        raise ValueError(f"The model provider kind must be one of {', '.join(KINDS)}")
    provider = {
        "kind": kind,
        "ollama_url": merged["ollama_url"],
        "ollama_model": _model_name(merged["ollama_model"], "ollama_model"),
        "ollama_fast_model": _model_name(merged["ollama_fast_model"], "ollama_fast_model"),
    }
    if kind == "ollama":
        provider["ollama_url"] = normalize_url(provider["ollama_url"])
        if not provider["ollama_model"]:
            raise ValueError("Choose the Ollama model Claude Code should use")
    elif not isinstance(provider["ollama_url"], str):
        raise ValueError("ollama_url must be a string")
    return provider


def environment(provider: dict[str, str]) -> dict[str, str]:
    """The variables `provider` adds to a `claude` process' environment."""
    if provider["kind"] != "ollama":
        return {}
    main = provider["ollama_model"]
    fast = provider["ollama_fast_model"] or main
    env = {
        "ANTHROPIC_BASE_URL": provider["ollama_url"],
        "ANTHROPIC_AUTH_TOKEN": "ollama",
        "ANTHROPIC_API_KEY": "",
    }
    env.update({name: main for name in MAIN_MODEL_VARIABLES})
    env.update({name: fast for name in FAST_MODEL_VARIABLES})
    return env


def load() -> dict[str, str]:
    """The stored provider; raises ValueError when settings.json holds an invalid one."""
    from gilzacode import settings
    return normalize(settings.load().get("model_provider", DEFAULTS))


def save(raw: Any) -> dict[str, str]:
    """Validate and store a provider; return it as stored."""
    from gilzacode import settings
    provider = normalize(raw)
    settings.save({"model_provider": provider})
    return provider
