"""Pronounce: settings, the audio endpoint and the voices endpoints (local engine only)."""

import pytest

from gilzacode.speech import config as speech_config
from gilzacode.speech import voice_store
from gilzacode.speech.errors import SpeechSynthesisError


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(voice_store, "voices_dir", lambda: tmp_path / "voices")
    return tmp_path / "voices"


def _install(store, key):
    target = store / key
    target.mkdir(parents=True)
    (target / f"{key}.onnx").write_bytes(b"x")
    (target / f"{key}.onnx.json").write_text("{}", encoding="utf-8")


async def test_speech_ships_disabled_and_says_what_to_do(client, store):
    data = await (await client.get("/api/settings/speech")).json()
    assert data["enabled"] is False and data["engines"] == ["local"]
    assert "disabled" in data["problem"]
    response = await client.post("/api/speech", json={"text": "hello"})
    assert response.status == 503 and (await response.json())["kind"] == "not_configured"


async def test_settings_round_trip_and_clamping(client, store):
    data = await (await client.post("/api/settings/speech", json={"enabled": True, "speed": 99})).json()
    assert data["enabled"] is True and data["speed"] == speech_config.MAX_SPEED
    assert "No voice is installed" in data["problem"]


async def test_the_remote_engine_is_refused_not_ignored(client, store):
    response = await client.post("/api/settings/speech", json={"enabled": True, "engine": "remote"})
    assert response.status == 400
    assert speech_config.load_config()["enabled"] is False


async def test_the_audio_is_the_response_body(client, store, monkeypatch):
    _install(store, "pt_BR-faber-medium")
    await client.post("/api/settings/speech", json={"enabled": True, "local_voice": "pt_BR-faber-medium"})
    monkeypatch.setattr("gilzacode.speech.phonemes.availability_problem", lambda: "")
    seen = {}

    def fake_wav(path, text, speaker, length_scale):
        seen.update(path=path, text=text, length_scale=length_scale)
        return b"RIFF....WAVE", 22050

    monkeypatch.setattr("gilzacode.speech.local_onnx.synthesize_wav", fake_wav)
    response = await client.post("/api/speech", json={"text": "  olá  ", "speed": 2})
    assert response.status == 200 and response.content_type == "audio/wav"
    assert await response.read() == b"RIFF....WAVE"
    assert seen["text"] == "olá" and seen["length_scale"] == 0.5
    assert seen["path"].endswith("pt_BR-faber-medium.onnx")


async def test_bad_snippets_and_engine_failures_keep_their_classification(client, store, monkeypatch):
    _install(store, "v")
    await client.post("/api/settings/speech", json={"enabled": True, "local_voice": "v"})
    monkeypatch.setattr("gilzacode.speech.phonemes.availability_problem", lambda: "")
    assert (await client.post("/api/speech", json={"text": " "})).status == 400
    long = await client.post("/api/speech", json={"text": "x" * (speech_config.MAX_SPEECH_CHARS + 1)})
    assert long.status == 400 and (await long.json())["kind"] == "bad_request"

    def refuse(*_args):
        raise SpeechSynthesisError("This text produced no pronounceable phonemes.", kind="bad_request")

    monkeypatch.setattr("gilzacode.speech.local_onnx.synthesize_wav", refuse)
    failed = await client.post("/api/speech", json={"text": "..."})
    assert failed.status == 400 and "phonemes" in (await failed.json())["error"]


async def test_a_missing_espeak_is_the_reported_problem(client, store, monkeypatch):
    _install(store, "v")
    await client.post("/api/settings/speech", json={"enabled": True, "local_voice": "v"})
    monkeypatch.setattr("gilzacode.speech.phonemes.availability_problem", lambda: "espeak-ng is not installed.")
    assert (await (await client.get("/api/settings/speech")).json())["problem"] == "espeak-ng is not installed."


async def test_voices_are_listed_offline_and_removing_the_selected_one_clears_it(client, store, monkeypatch):
    _install(store, "v")
    await client.post("/api/settings/speech", json={"enabled": True, "local_voice": "v"})

    def offline(*_a, **_k):
        raise voice_store.VoiceStoreError("offline", kind="connection")

    monkeypatch.setattr(voice_store, "list_catalog", offline)
    data = await (await client.get("/api/speech/voices")).json()
    assert data["installed"] == ["v"] and data["catalog"] == [] and data["catalog_error"] == "offline"

    assert (await client.post("/api/speech/voices/remove", json={"key": "v"})).status == 200
    assert speech_config.load_config()["local_voice"] == ""
    bad = await client.post("/api/speech/voices/remove", json={"key": "../x"})
    assert bad.status == 400
