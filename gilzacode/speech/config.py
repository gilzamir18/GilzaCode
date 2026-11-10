"""Pronunciation settings, persisted at ``<gilzacode home>/speech.json``.

Ported from GilzaBots' ``speech_config.py``, **local engine only**: a downloaded
Piper voice run in this process. GilzaBots' "remote" engine called an
OpenAI-compatible speech endpoint through litellm and its model store; GilzaCode
makes no model API calls of its own, so that engine is not offered.

It ships disabled: speech needs a downloaded voice and the system espeak-ng,
which the install does not have yet, and a menu item that can only fail is
worse than an opt-in that says what is missing (`configuration_problem`).
"""

from __future__ import annotations

import json
from typing import Any

from gilzacode.paths import gilzacode_home, write_text_atomic

DEFAULT_SPEED = 1.0
MIN_SPEED = 0.25
MAX_SPEED = 4.0
ENGINES = ("local",)

#: Longer text is refused, not truncated: audio that stops mid-sentence sounds
#: exactly like audio that finished.
MAX_SPEECH_CHARS = 4000

_DEFAULTS: dict[str, Any] = {"enabled": False, "engine": "local", "local_voice": "", "speed": DEFAULT_SPEED}


def _path():
    return gilzacode_home() / "speech.json"


def load_config() -> dict[str, Any]:
    try:
        raw = json.loads(_path().read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            return {**_DEFAULTS, **{k: raw[k] for k in _DEFAULTS if k in raw}, "engine": "local"}
    except (OSError, ValueError):
        pass
    return dict(_DEFAULTS)


def sanitize_speed(value: Any) -> float:
    try:
        speed = float(value)
    except (TypeError, ValueError):
        return DEFAULT_SPEED
    if speed != speed:  # NaN
        return DEFAULT_SPEED
    return max(MIN_SPEED, min(MAX_SPEED, round(speed, 2)))


def save_config(config: dict[str, Any]) -> None:
    """Persist the known keys. A request for an engine other than "local" is refused."""
    engine = str(config.get("engine", "local") or "local").strip().lower()
    if engine != "local":
        raise ValueError("GilzaCode pronounces with a local voice only; the 'remote' engine is not available.")
    current = load_config()
    write_text_atomic(_path(), json.dumps({
        "enabled": bool(config.get("enabled", current["enabled"])),
        "engine": "local",
        "local_voice": str(config.get("local_voice", current["local_voice"]) or "").strip(),
        "speed": sanitize_speed(config.get("speed", current["speed"])),
    }, indent=2, ensure_ascii=False))


def configuration_problem() -> str:
    """An actionable reason speech cannot run, or ``""``."""
    from gilzacode.speech import voice_store
    from gilzacode.speech.phonemes import availability_problem

    cfg = load_config()
    if not cfg.get("enabled"):
        return "Speech synthesis is disabled. Enable it in Settings > General > Pronunciation."
    voice = str(cfg.get("local_voice", "") or "").strip()
    if not voice:
        return ("No voice is installed yet. Open Settings > General > Pronunciation and download one "
                "(about 63 MB); it then works offline.")
    if not voice_store.is_installed(voice):
        return f"The selected voice '{voice}' is not installed. Download it again in Settings > General > Pronunciation."
    # Last, because it is the one thing the application cannot fix: espeak-ng is
    # GPL-3.0 and is used from the system, never bundled.
    return availability_problem()


def synthesize(text: str, speed: Any = None) -> tuple[bytes, str]:
    """WAV audio of `text` with the configured voice. Blocking: run it in a worker thread.

    Raises ValueError for an empty or too-long snippet, `SpeechSynthesisError` otherwise.
    """
    from gilzacode.speech import voice_store
    from gilzacode.speech.local_onnx import synthesize_wav

    snippet = str(text or "").strip()
    if not snippet:
        raise ValueError("Pronunciation requires a non-empty text snippet.")
    if len(snippet) > MAX_SPEECH_CHARS:
        raise ValueError(f"The selected snippet is too long to pronounce "
                         f"({len(snippet)} characters, limit {MAX_SPEECH_CHARS}).")
    cfg = load_config()
    rate = sanitize_speed(speed if speed is not None else cfg.get("speed"))
    path = str(voice_store.voice_path(cfg["local_voice"]))
    # Piper's length_scale is duration, so it runs opposite to speed.
    wav, _rate = synthesize_wav(path, snippet, None, 1.0 / rate)
    return wav, "audio/wav"
