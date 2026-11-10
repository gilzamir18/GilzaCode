"""Text to IPA phonemes through the system espeak-ng, over ctypes.

**Why the system library, and never a bundled copy.** espeak-ng is GPL-3.0, and
so is every Python package that vendors it -- which is exactly why ``piper-tts``
relicensed from MIT (1.2.0) to GPL-3.0-or-later (1.3.0) when it absorbed
espeak-ng. Loading the library the user already has is *use*, not distribution:
nothing copyleft is shipped, and a host that does not have it gets a precise
instruction instead of a broken feature.

The library is found through ``ctypes.util.find_library`` and the platform's
usual sonames, and espeak-ng locates its own data directory when initialized
with a NULL path, so nothing here hardcodes a filesystem layout.

espeak-ng keeps the selected voice in global state and is not reentrant, so
every call into it is serialized by one module-level lock.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import sys
import threading
from dataclasses import dataclass

# espeak_AUDIO_OUTPUT: synchronous, so nothing tries to open an audio device --
# this process only ever asks for phonemes.
_AUDIO_OUTPUT_SYNCHRONOUS = 0x02
_CHARS_UTF8 = 1
# phonememode bit 1: return the International Phonetic Alphabet as UTF-8.
_PHONEMES_IPA = 0x02

# Tried in order. `find_library` first, because it honours the platform's own
# search rules; the explicit names cover hosts where it returns nothing.
_LIBRARY_NAMES = {
    "linux": ("libespeak-ng.so.1", "libespeak-ng.so"),
    "darwin": ("libespeak-ng.1.dylib", "libespeak-ng.dylib"),
    "win32": ("libespeak-ng.dll", "espeak-ng.dll"),
}

_INSTALL_HINT = {
    "linux": "install the espeak-ng library (Debian/Ubuntu: 'sudo apt install libespeak-ng1', Fedora: 'sudo dnf install espeak-ng')",
    "darwin": "install espeak-ng (Homebrew: 'brew install espeak-ng')",
    "win32": "install espeak-ng from https://github.com/espeak-ng/espeak-ng/releases and make sure libespeak-ng.dll is on PATH",
}


class PhonemizerError(RuntimeError):
    """Raised when text cannot be converted to phonemes.

    ``kind`` is ``"not_installed"`` when the host simply has no espeak-ng --
    a condition the user can fix and must be told about specifically -- and
    ``"failed"`` for anything else.
    """

    def __init__(self, message: str, kind: str = "failed") -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class Clause:
    """One spoken clause: its IPA phonemes and the punctuation that ended it.

    espeak returns a clause at a time and drops the terminator, but a Piper
    voice has ids for ``.``, ``,``, ``?`` and ``!`` and uses them for prosody.
    Recovering the terminator from the source span is what keeps a question
    sounding like a question.
    """

    phonemes: str
    terminator: str = ""


_lock = threading.Lock()
_lib = None
_initialized = False
_current_voice = ""


def _platform_key() -> str:
    if sys.platform.startswith("linux"):
        return "linux"
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform in ("win32", "cygwin"):
        return "win32"
    return "linux"


def install_hint() -> str:
    """Return a platform-specific instruction for installing espeak-ng."""
    return _INSTALL_HINT[_platform_key()]


def _candidate_names() -> tuple[str, ...]:
    found = ctypes.util.find_library("espeak-ng")
    names = _LIBRARY_NAMES[_platform_key()]
    return ((found,) + names) if found else names


def _load_library():
    global _lib, _initialized
    if _lib is not None:
        return _lib

    errors = []
    for name in _candidate_names():
        try:
            lib = ctypes.CDLL(name)
        except OSError as exc:
            errors.append(f"{name}: {exc}")
            continue

        lib.espeak_Initialize.restype = ctypes.c_int
        lib.espeak_SetVoiceByName.restype = ctypes.c_int
        lib.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
        lib.espeak_TextToPhonemes.restype = ctypes.c_char_p
        lib.espeak_TextToPhonemes.argtypes = [
            ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.c_int
        ]

        # A NULL data path makes espeak-ng find its own installation.
        if lib.espeak_Initialize(_AUDIO_OUTPUT_SYNCHRONOUS, 0, None, 0) <= 0:
            errors.append(f"{name}: espeak_Initialize failed")
            continue

        _lib = lib
        _initialized = True
        return _lib

    raise PhonemizerError(
        "espeak-ng was not found, so text cannot be converted to phonemes. "
        f"To use a local voice, {install_hint()}. "
        f"(tried: {'; '.join(errors) or 'no candidates'})",
        kind="not_installed",
    )


def is_available() -> bool:
    """Return whether espeak-ng can be loaded, without raising."""
    with _lock:
        try:
            _load_library()
            return True
        except PhonemizerError:
            return False


def availability_problem() -> str:
    """Return "" when espeak-ng is usable, else an actionable message."""
    with _lock:
        try:
            _load_library()
            return ""
        except PhonemizerError as exc:
            return str(exc)


# Terminators a Piper voice has phoneme ids for. Anything else is dropped
# rather than guessed at.
_TERMINATORS = ".,;:?!"


def _terminator_in(span: str) -> str:
    for char in reversed(span.strip()):
        if char in _TERMINATORS:
            return char
        if char.isalnum():
            break
    return ""


def phonemize(text: str, voice: str) -> list[Clause]:
    """Convert *text* into IPA clauses using espeak's *voice* (e.g. ``pt-br``).

    Raises ``PhonemizerError`` when espeak-ng is missing or rejects the voice.
    """
    global _current_voice

    content = str(text or "").strip()
    if not content:
        return []

    with _lock:
        lib = _load_library()

        voice_name = str(voice or "").strip() or "en-us"
        if voice_name != _current_voice:
            if lib.espeak_SetVoiceByName(voice_name.encode("utf-8")) != 0:
                raise PhonemizerError(
                    f"espeak-ng does not have a voice named '{voice_name}'."
                )
            _current_voice = voice_name

        raw = content.encode("utf-8")
        buffer = ctypes.create_string_buffer(raw)
        base = ctypes.addressof(buffer)
        pointer = ctypes.c_void_p(base)

        clauses: list[Clause] = []
        offset = 0
        # A clause that yields no phonemes still advances the pointer, so the
        # loop is bounded by the text length rather than by producing output.
        while pointer.value:
            result = lib.espeak_TextToPhonemes(
                ctypes.byref(pointer), _CHARS_UTF8, _PHONEMES_IPA
            )
            next_offset = (pointer.value - base) if pointer.value else len(raw)
            span = raw[offset:next_offset].decode("utf-8", "replace")
            offset = next_offset

            if result is None:
                break
            phonemes = result.decode("utf-8", "replace").strip()
            if phonemes:
                clauses.append(Clause(phonemes=phonemes, terminator=_terminator_in(span)))

        return clauses
