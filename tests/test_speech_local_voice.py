"""Tests for the local Piper voice engine and the voice store.

Nothing here downloads a model or requires espeak-ng to be installed: the
phonemizer and the ONNX session are replaced with fakes, and the HTTP transfer
is served from a local fixture. What is pinned down is the contract around them
-- that phonemes map onto the voice's own vocabulary, that a corrupt download is
discarded rather than installed, that a voice key from the client cannot escape
the voice directory, and that a missing espeak-ng reads as something the user
can fix.
"""

import hashlib
import json
import wave
import io
from pathlib import Path

import pytest

from gilzacode.speech import local_onnx, phonemes, voice_store
from gilzacode.speech.errors import SpeechSynthesisError
from gilzacode.speech.local_onnx import phoneme_ids
from gilzacode.speech.voice_store import VoiceStoreError


# ─── Phoneme mapping ─────────────────────────────────────────────────────────

ID_MAP = {
    "_": [0], "^": [1], "$": [2], " ": [3],
    "a": [10], "b": [11], "k": [12], ".": [20], "?": [21],
}


def test_phonemes_are_interleaved_with_the_pad_symbol():
    # Piper was trained on <pad>-separated phonemes; dropping the interleave
    # produces audio that is recognisably wrong rather than merely worse.
    ids = phoneme_ids("ab", ID_MAP)

    assert ids == [1, 0, 10, 0, 11, 0, 2]


def test_a_phoneme_the_voice_does_not_know_is_skipped_not_substituted():
    # The id table is the model's vocabulary. Inventing an entry would ask the
    # voice to make a sound it was never trained to make.
    ids = phoneme_ids("aXb", ID_MAP)

    assert ids == phoneme_ids("ab", ID_MAP)


def test_the_clause_terminator_reaches_the_model():
    # espeak drops the punctuation that ended a clause, but a Piper voice has
    # ids for it and uses them for prosody — it is what keeps a question
    # sounding like a question.
    plain = phoneme_ids("a", ID_MAP)
    asked = phoneme_ids("a", ID_MAP, "?")

    assert 21 in asked
    assert 21 not in plain
    assert asked[-1] == 2


def test_an_unknown_terminator_is_dropped_rather_than_guessed():
    assert phoneme_ids("a", ID_MAP, ";") == phoneme_ids("a", ID_MAP)


@pytest.mark.parametrize("span,expected", [
    ("Hello world.", "."),
    ("really?  ", "?"),
    ("wait,", ","),
    ("no punctuation", ""),
    ("", ""),
])
def test_terminator_is_read_from_the_source_span(span, expected):
    assert phonemes._terminator_in(span) == expected


# ─── Local synthesis ─────────────────────────────────────────────────────────

class _FakeSession:
    """Stands in for an onnxruntime session over a single-speaker voice."""

    def __init__(self, inputs=("input", "input_lengths", "scales")):
        self._inputs = inputs
        self.calls = []

    def get_inputs(self):
        return [type("I", (), {"name": name})() for name in self._inputs]

    def run(self, _outputs, feeds):
        import numpy as np

        self.calls.append(feeds)
        # One sample per phoneme id keeps the output deterministic and lets a
        # test assert on the length that reached the model.
        return [np.linspace(-0.5, 0.5, len(feeds["input"][0]), dtype=np.float32)]


@pytest.fixture
def fake_voice(monkeypatch):
    session = _FakeSession()
    config = {
        "phoneme_id_map": ID_MAP,
        "espeak": {"voice": "pt-br"},
        "audio": {"sample_rate": 16000},
        "inference": {"noise_scale": 0.6, "length_scale": 1.0, "noise_w": 0.8},
    }
    monkeypatch.setattr(local_onnx, "load_voice", lambda path: (session, config))
    monkeypatch.setattr(
        local_onnx, "phonemize",
        lambda text, voice: [phonemes.Clause(phonemes="ab", terminator=".")],
    )
    return session


def test_local_synthesis_returns_a_playable_wav(fake_voice):
    wav, rate = local_onnx.synthesize_wav("voice.onnx", "qualquer texto")

    assert rate == 16000
    with wave.open(io.BytesIO(wav)) as handle:
        assert handle.getnchannels() == 1
        assert handle.getsampwidth() == 2
        assert handle.getframerate() == 16000
        assert handle.getnframes() > 0


def test_speed_becomes_an_inverse_length_scale(fake_voice):
    # Piper's length_scale is duration, so it runs opposite to "speed": asking
    # for 2x faster is a length scale of 0.5. Getting this backwards makes the
    # speed control do the opposite of what it says.
    local_onnx.synthesize_wav("voice.onnx", "texto", length_scale=0.5)

    assert fake_voice.calls[-1]["scales"][1] == pytest.approx(0.5)


def test_a_single_speaker_voice_is_not_handed_a_speaker_id(fake_voice):
    local_onnx.synthesize_wav("voice.onnx", "texto", speaker_id=3)

    assert "sid" not in fake_voice.calls[-1]


def test_a_multi_speaker_voice_receives_the_speaker_id(monkeypatch):
    session = _FakeSession(inputs=("input", "input_lengths", "scales", "sid"))
    monkeypatch.setattr(local_onnx, "load_voice", lambda path: (session, {
        "phoneme_id_map": ID_MAP,
        "espeak": {"voice": "en-us"},
        "audio": {"sample_rate": 16000},
        "inference": {},
    }))
    monkeypatch.setattr(local_onnx, "phonemize",
                        lambda text, voice: [phonemes.Clause(phonemes="ab")])

    local_onnx.synthesize_wav("voice.onnx", "text", speaker_id=3)

    assert session.calls[-1]["sid"].tolist() == [3]


def test_a_missing_espeak_reads_as_something_the_user_can_fix(monkeypatch):
    # "not_configured" routes to an instruction in the UI; "bad_request" would
    # read as "this text is wrong", which is not the problem.
    def boom(text, voice):
        raise phonemes.PhonemizerError("no espeak here", kind="not_installed")

    monkeypatch.setattr(local_onnx, "load_voice", lambda path: (_FakeSession(), {
        "phoneme_id_map": ID_MAP, "espeak": {"voice": "pt-br"},
        "audio": {"sample_rate": 16000}, "inference": {},
    }))
    monkeypatch.setattr(local_onnx, "phonemize", boom)

    with pytest.raises(SpeechSynthesisError) as exc:
        local_onnx.synthesize_wav("voice.onnx", "texto")

    assert exc.value.kind == "not_configured"


def test_text_with_no_pronounceable_phonemes_is_reported(monkeypatch):
    monkeypatch.setattr(local_onnx, "load_voice", lambda path: (_FakeSession(), {
        "phoneme_id_map": ID_MAP, "espeak": {"voice": "pt-br"},
        "audio": {"sample_rate": 16000}, "inference": {},
    }))
    monkeypatch.setattr(local_onnx, "phonemize", lambda text, voice: [])

    with pytest.raises(SpeechSynthesisError) as exc:
        local_onnx.synthesize_wav("voice.onnx", "***")

    assert exc.value.kind == "bad_request"


def test_a_voice_file_that_is_not_there_says_so(tmp_path):
    with pytest.raises(SpeechSynthesisError) as exc:
        local_onnx.load_voice(tmp_path / "absent.onnx")

    assert exc.value.kind == "not_configured"


def test_a_voice_without_its_config_names_the_missing_file(tmp_path):
    model = tmp_path / "voice.onnx"
    model.write_bytes(b"not really a model")

    with pytest.raises(SpeechSynthesisError) as exc:
        local_onnx.load_voice(model)

    assert exc.value.kind == "not_configured"
    assert "voice.onnx.json" in str(exc.value)


# ─── Voice store ─────────────────────────────────────────────────────────────

@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(voice_store, "voices_dir", lambda: tmp_path / "voices")
    return tmp_path / "voices"


@pytest.mark.parametrize("key", ["../../etc/passwd", "a/b", "", "  ", "x" * 200, "./x"])
def test_a_voice_key_cannot_escape_the_voice_directory(store, key):
    # The key arrives from the client and names a directory.
    with pytest.raises(VoiceStoreError) as exc:
        voice_store.voice_path(key)
    assert exc.value.kind == "bad_request"


def test_a_valid_key_resolves_inside_the_store(store):
    path = voice_store.voice_path("pt_BR-faber-medium")

    assert path.name == "pt_BR-faber-medium.onnx"
    assert str(path).startswith(str(store))


def test_a_voice_needs_both_files_to_count_as_installed(store):
    target = store / "v"
    target.mkdir(parents=True)
    (target / "v.onnx").write_bytes(b"model")

    # A model without its config would be listed as available and then fail at
    # synthesis time.
    assert voice_store.is_installed("v") is False
    assert voice_store.installed_voices() == []

    (target / "v.onnx.json").write_text("{}")
    assert voice_store.is_installed("v") is True
    assert voice_store.installed_voices() == ["v"]


def _serve(monkeypatch, payloads):
    """Serve `payloads` (url suffix -> bytes) to urllib without a network."""
    class _Response(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(request, timeout=None):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        for suffix, body in payloads.items():
            if url.endswith(suffix):
                return _Response(body)
        raise AssertionError(f"unexpected url {url}")

    monkeypatch.setattr(voice_store.urllib.request, "urlopen", fake_urlopen)


def _catalog_for(key, model_bytes, config_bytes):
    return {
        key: {
            "key": key, "name": "faber", "quality": "medium", "num_speakers": 1,
            "language": {"code": "pt_BR", "name_english": "Portuguese",
                         "name_native": "Português", "country_english": "Brazil"},
            "files": {
                f"pt/{key}.onnx": {
                    "size_bytes": len(model_bytes),
                    "md5_digest": hashlib.md5(model_bytes).hexdigest(),
                },
                f"pt/{key}.onnx.json": {
                    "size_bytes": len(config_bytes),
                    "md5_digest": hashlib.md5(config_bytes).hexdigest(),
                },
                f"pt/MODEL_CARD": {"size_bytes": 10, "md5_digest": "x"},
            },
        }
    }


def test_a_download_installs_both_files_and_ignores_the_model_card(store, monkeypatch):
    key = "pt_BR-faber-medium"
    model, config = b"onnx-model-bytes", b'{"phoneme_id_map": {}}'
    catalog = _catalog_for(key, model, config)
    _serve(monkeypatch, {
        "voices.json": json.dumps(catalog).encode(),
        f"{key}.onnx": model,
        f"{key}.onnx.json": config,
    })

    summary = voice_store.download_voice(key)

    assert summary["language_code"] == "pt_BR"
    # The MODEL_CARD is listed upstream but is not part of the voice.
    assert sorted(p.name for p in (store / key).iterdir()) == [
        f"{key}.onnx", f"{key}.onnx.json"
    ]
    assert voice_store.is_installed(key)


def test_a_corrupt_download_is_discarded_not_installed(store, monkeypatch):
    # A truncated 63 MB model otherwise surfaces much later as an opaque ONNX
    # parse error, which reads like a bug in the feature.
    key = "pt_BR-faber-medium"
    model, config = b"onnx-model-bytes", b"{}"
    catalog = _catalog_for(key, model, config)
    _serve(monkeypatch, {
        "voices.json": json.dumps(catalog).encode(),
        f"{key}.onnx": b"corrupted payload",
        f"{key}.onnx.json": config,
    })

    with pytest.raises(VoiceStoreError) as exc:
        voice_store.download_voice(key)

    assert exc.value.kind == "corrupt"
    assert not voice_store.is_installed(key)
    assert voice_store.download_progress()[key]["state"] == "error"


def test_an_unknown_voice_is_reported_before_anything_is_written(store, monkeypatch):
    _serve(monkeypatch, {"voices.json": json.dumps({}).encode()})

    with pytest.raises(VoiceStoreError) as exc:
        voice_store.download_voice("pt_BR-nobody-medium")

    assert exc.value.kind == "not_found"


def test_the_catalog_falls_back_to_its_cache_when_offline(store, monkeypatch):
    key = "pt_BR-faber-medium"
    catalog = _catalog_for(key, b"m", b"c")
    _serve(monkeypatch, {"voices.json": json.dumps(catalog).encode()})
    assert voice_store.load_catalog(refresh=True)

    def offline(request, timeout=None):
        raise OSError("network is unreachable")

    monkeypatch.setattr(voice_store.urllib.request, "urlopen", offline)

    # Being offline must not empty the list: the local engine's whole point is
    # that it keeps working without a network.
    assert key in voice_store.load_catalog(refresh=True)


def test_removing_a_voice_deletes_it_and_frees_the_session(store, monkeypatch):
    target = store / "v"
    target.mkdir(parents=True)
    (target / "v.onnx").write_bytes(b"model")
    (target / "v.onnx.json").write_text("{}")

    cleared = []
    monkeypatch.setattr(local_onnx, "clear_cache", lambda: cleared.append(True))

    voice_store.remove_voice("v")

    assert not target.exists()
    # A cached session keeps the file open on Windows and would keep serving a
    # voice the user just deleted everywhere else.
    assert cleared == [True]


def test_removing_a_voice_that_is_not_there_says_so(store):
    with pytest.raises(VoiceStoreError) as exc:
        voice_store.remove_voice("absent")

    assert exc.value.kind == "not_found"
