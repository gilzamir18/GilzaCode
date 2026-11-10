"""A Piper-format voice run in this process (copied from AgenticBlocks' speech block).

A Piper voice is a VITS model exported to ONNX plus a JSON config carrying its
phoneme table, sample rate and inference defaults. Both are permissively licensed
(``rhasspy/piper-voices`` is MIT) and one voice is ~63 MB, so text is read aloud
with no network at all.

* **Synthesis is synchronous and CPU-bound**; callers run `synthesize_wav` in a
  worker thread so the server's event loop never stalls.
* **Sessions are cached by path and mtime**: re-reading 63 MB per utterance would
  dominate the cost of speaking a sentence.
"""

from __future__ import annotations

import io
import json
import os
import threading
import wave
from pathlib import Path
from typing import Any

from gilzacode.speech.errors import SpeechSynthesisError
from gilzacode.speech.phonemes import PhonemizerError, phonemize

# Piper's sentinel symbols. Every phoneme is followed by the pad symbol, which
# is how the model was trained; dropping the interleave produces audio that is
# recognisably wrong rather than merely worse.
_BOS = "^"
_EOS = "$"
_PAD = "_"

# Silence inserted between clauses, in seconds. Without it a multi-sentence
# excerpt runs together.
_CLAUSE_GAP = 0.20

# How many voices to keep loaded. Small on purpose: each session holds its
# model's weights, and a reader uses one voice at a time.
_MAX_CACHED = 2

_cache: "dict[str, tuple[float, Any, dict]]" = {}
_cache_lock = threading.Lock()


def _load_config(model_path: Path) -> dict:
    # Piper ships the config as "<model>.onnx.json"; some mirrors drop the
    # ".onnx". Both are accepted, and a missing config is reported as such
    # rather than surfacing later as a confusing phoneme-table error.
    for candidate in (
        model_path.with_name(model_path.name + ".json"),
        model_path.with_suffix(".json"),
    ):
        if candidate.is_file():
            try:
                return json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise SpeechSynthesisError(
                    f"The voice config '{candidate.name}' could not be read: {exc}",
                    kind="bad_request",
                ) from exc
    raise SpeechSynthesisError(
        f"No config found next to '{model_path.name}'. A Piper voice needs its "
        f"'{model_path.name}.json' alongside the model file.",
        kind="not_configured",
    )


def load_voice(model_path: str | os.PathLike) -> tuple[Any, dict]:
    """Return a cached ``(onnx session, config)`` pair for *model_path*."""
    path = Path(model_path)
    if not path.is_file():
        raise SpeechSynthesisError(
            f"The voice file '{path}' does not exist.", kind="not_configured"
        )

    key = str(path.resolve())
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0

    with _cache_lock:
        cached = _cache.get(key)
        if cached and cached[0] == mtime:
            return cached[1], cached[2]

    try:
        import onnxruntime
    except ImportError as exc:
        raise SpeechSynthesisError(
            "onnxruntime is required to run a local voice but is not installed.",
            kind="not_configured",
        ) from exc

    config = _load_config(path)
    options = onnxruntime.SessionOptions()
    # The host is an interactive application, not a batch job: a synthesis that
    # saturates every core makes the rest of the UI stutter for the half second
    # it runs.
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = max(1, min(4, (os.cpu_count() or 2) // 2))
    try:
        session = onnxruntime.InferenceSession(
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
    except Exception as exc:  # noqa: BLE001 - surfaced as a classified error
        raise SpeechSynthesisError(
            f"The voice '{path.name}' could not be loaded: {exc}", kind="bad_request"
        ) from exc

    with _cache_lock:
        _cache[key] = (mtime, session, config)
        while len(_cache) > _MAX_CACHED:
            _cache.pop(next(iter(_cache)))

    return session, config


def clear_cache() -> None:
    """Drop every loaded voice. Used when a voice file is replaced or removed."""
    with _cache_lock:
        _cache.clear()


def phoneme_ids(phonemes: str, id_map: dict[str, list[int]], terminator: str = "") -> list[int]:
    """Map IPA *phonemes* onto the voice's ids, in Piper's interleaved layout.

    A phoneme the voice does not know is skipped rather than substituted: the
    id table is the model's vocabulary, and inventing an entry produces a sound
    the voice was never trained to make.
    """
    ids: list[int] = list(id_map.get(_BOS, []))
    ids += id_map.get(_PAD, [])
    for symbol in phonemes:
        mapped = id_map.get(symbol)
        if not mapped:
            continue
        ids += mapped
        ids += id_map.get(_PAD, [])
    if terminator:
        mapped = id_map.get(terminator)
        if mapped:
            ids += mapped
            ids += id_map.get(_PAD, [])
    ids += id_map.get(_EOS, [])
    return ids


def _encode_wav(samples, sample_rate: int) -> bytes:
    import numpy as np

    if samples.size == 0:
        raise SpeechSynthesisError(
            "The voice produced no audio for this text.", kind="empty"
        )
    peak = float(np.max(np.abs(samples)))
    # Piper's own normalisation. The floor keeps a near-silent clause from being
    # amplified into noise.
    scaled = samples * (32767.0 / max(0.01, peak))
    pcm = np.clip(scaled, -32768, 32767).astype("<i2")

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


def synthesize_wav(
    model_path: str | os.PathLike,
    text: str,
    speaker_id: int | None = None,
    length_scale: float | None = None,
    noise_scale: float | None = None,
    noise_w: float | None = None,
) -> tuple[bytes, int]:
    """Synthesize *text* with the voice at *model_path*; return ``(wav, rate)``.

    Synchronous and CPU-bound: call it from a worker thread.
    """
    import numpy as np

    session, config = load_voice(model_path)
    id_map = config.get("phoneme_id_map") or {}
    if not id_map:
        raise SpeechSynthesisError(
            "This voice config carries no phoneme table.", kind="bad_request"
        )

    espeak_voice = str((config.get("espeak") or {}).get("voice") or "").strip()
    inference = config.get("inference") or {}
    sample_rate = int((config.get("audio") or {}).get("sample_rate") or 22050)

    try:
        clauses = phonemize(text, espeak_voice)
    except PhonemizerError as exc:
        # The distinction matters: "espeak-ng is not installed" is something the
        # user fixes in a minute, and must not read as "synthesis failed".
        raise SpeechSynthesisError(
            str(exc),
            kind="not_configured" if exc.kind == "not_installed" else "bad_request",
        ) from exc

    if not clauses:
        raise SpeechSynthesisError(
            "This text produced no pronounceable phonemes.", kind="bad_request"
        )

    scales = np.array([
        float(noise_scale if noise_scale is not None else inference.get("noise_scale", 0.667)),
        float(length_scale if length_scale is not None else inference.get("length_scale", 1.0)),
        float(noise_w if noise_w is not None else inference.get("noise_w", 0.8)),
    ], dtype=np.float32)

    input_names = {i.name for i in session.get_inputs()}
    gap = np.zeros(int(sample_rate * _CLAUSE_GAP), dtype=np.float32)

    parts: list[Any] = []
    for index, clause in enumerate(clauses):
        ids = phoneme_ids(clause.phonemes, id_map, clause.terminator)
        if len(ids) <= 2:
            continue
        feeds = {
            "input": np.array([ids], dtype=np.int64),
            "input_lengths": np.array([len(ids)], dtype=np.int64),
            "scales": scales,
        }
        # Multi-speaker voices carry a speaker id; single-speaker ones have no
        # such input and reject it.
        if "sid" in input_names:
            feeds["sid"] = np.array([int(speaker_id or 0)], dtype=np.int64)

        try:
            audio = session.run(None, feeds)[0]
        except Exception as exc:  # noqa: BLE001 - surfaced as a classified error
            raise SpeechSynthesisError(
                f"The voice failed to synthesize this text: {exc}", kind="unknown"
            ) from exc

        if index:
            parts.append(gap)
        parts.append(np.asarray(audio, dtype=np.float32).reshape(-1))

    if not parts:
        raise SpeechSynthesisError(
            "This text produced no pronounceable phonemes.", kind="bad_request"
        )

    return _encode_wav(np.concatenate(parts), sample_rate), sample_rate
