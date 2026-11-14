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
  ``ANTHROPIC_AUTH_TOKEN`` and an empty ``ANTHROPIC_API_KEY``. The server is a
  local Ollama (whose ``:cloud`` models run on ollama.com once it is signed in)
  or ollama.com itself, which needs an API key. The token is that key, or
  ``ollama`` when there is none. It ranks above a claude.ai login in Claude
  Code's authentication order, so the login stays stored and is used again
  once the provider is switched back.

GilzaCode passes model aliases (``--model haiku`` for Translate, ``sonnet`` for
Look up), and Claude Code's own agents use aliases too. Ollama knows its models
by their own names, so each alias is mapped to the chosen model through Claude
Code's ``ANTHROPIC_DEFAULT_<ALIAS>_MODEL`` variables. ``haiku``, the alias for
quick work, maps to the "fast" model when one is chosen.

The API key is a credential: it is kept out of ``settings.json`` in a file only
the user can read (``<gilzacode home>/ollama_api_key``), and it is never sent
back to the interface, which only learns whether one is stored.
"""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

KINDS = ("anthropic", "ollama")
DEFAULT_OLLAMA_URL = "http://localhost:11434"
OLLAMA_CLOUD_URL = "https://ollama.com"

DEFAULTS: dict[str, str] = {
    "kind": "anthropic",
    "ollama_url": DEFAULT_OLLAMA_URL,
    "ollama_model": "",
    "ollama_fast_model": "",
}

#: The request field that carries the API key. It is not part of the stored
#: provider: absent keeps the stored key, "" removes it, any other value replaces it.
API_KEY_FIELD = "ollama_api_key"
#: Sent instead of a key, as Ollama's Claude Code guide does for a local server.
NO_KEY_TOKEN = "ollama"

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
API_KEY_MAX_CHARS = 1000


def _token(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    text = value.strip()
    if len(text) > limit:
        raise ValueError(f"{field} is longer than {limit} characters")
    if any(ch.isspace() or ord(ch) < 32 for ch in text):
        raise ValueError(f"{field} must not contain spaces or control characters")
    return text


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


def normalize_api_key(value: Any) -> str:
    return _token(value, "The API key", API_KEY_MAX_CHARS)


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
        "ollama_model": _token(merged["ollama_model"], "ollama_model", MODEL_NAME_MAX_CHARS),
        "ollama_fast_model": _token(merged["ollama_fast_model"], "ollama_fast_model", MODEL_NAME_MAX_CHARS),
    }
    if kind == "ollama":
        provider["ollama_url"] = normalize_url(provider["ollama_url"])
        if not provider["ollama_model"]:
            raise ValueError("Choose the Ollama model Claude Code should use")
    elif not isinstance(provider["ollama_url"], str):
        raise ValueError("ollama_url must be a string")
    return provider


def environment(provider: dict[str, str], api_key: str = "") -> dict[str, str]:
    """The variables `provider` adds to a `claude` process' environment."""
    if provider["kind"] != "ollama":
        return {}
    main = provider["ollama_model"]
    fast = provider["ollama_fast_model"] or main
    env = {
        "ANTHROPIC_BASE_URL": provider["ollama_url"],
        "ANTHROPIC_AUTH_TOKEN": api_key or NO_KEY_TOKEN,
        "ANTHROPIC_API_KEY": "",
    }
    env.update({name: main for name in MAIN_MODEL_VARIABLES})
    env.update({name: fast for name in FAST_MODEL_VARIABLES})
    return env


# ── The API key ──────────────────────────────────────────────────────────────

def api_key_path() -> Path:
    from gilzacode.paths import gilzacode_home
    return gilzacode_home() / "ollama_api_key"


def load_api_key() -> str:
    """The stored API key, or ""; raises ValueError when the file holds something invalid."""
    try:
        text = api_key_path().read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    return normalize_api_key(text)


def _store_api_key(key: str) -> None:
    path = api_key_path()
    if not key:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        # Restricted before the key is written, so it is never readable by others.
        try:
            os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass  # Windows ignores POSIX modes; the file is in the user's profile
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(key)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


# ── Stored provider ──────────────────────────────────────────────────────────

def load() -> dict[str, str]:
    """The stored provider (without the key); raises ValueError when settings.json holds an invalid one."""
    from gilzacode import settings
    return normalize(settings.load().get("model_provider", DEFAULTS))


def current_environment() -> dict[str, str]:
    """What the stored provider adds to a `claude` process; raises ValueError when it is invalid."""
    provider = load()
    return environment(provider, load_api_key() if provider["kind"] == "ollama" else "")


def public_view(provider: dict[str, str]) -> dict[str, Any]:
    """The provider as the interface sees it: whether a key is stored, never the key."""
    try:
        has_key = bool(load_api_key())
    except ValueError:
        has_key = True  # a file is there; current_environment() reports what is wrong with it
    return {**provider, "ollama_api_key_set": has_key}


def save(raw: Any) -> dict[str, str]:
    """Validate a provider (and an optional new key) and store them; return the provider.

    Everything is validated before anything is written.
    """
    if not isinstance(raw, dict):
        raise ValueError("The model provider must be an object")
    fields = dict(raw)
    new_key = normalize_api_key(fields.pop(API_KEY_FIELD)) if API_KEY_FIELD in fields else None
    provider = normalize(fields)
    from gilzacode import settings
    settings.save({"model_provider": provider})
    if new_key is not None:
        _store_api_key(new_key)
    return provider
