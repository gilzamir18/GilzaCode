"""The model provider: which service the `claude` processes GilzaCode starts talk to."""

import json
import socket
import sys

import pytest
from aiohttp import web

from gilzacode import claude_cli, model_provider, settings
from gilzacode.server.routes_terminal import CLAUDE_ID, SESSIONS_KEY

OLLAMA = {"kind": "ollama", "ollama_url": "http://localhost:11434/", "ollama_model": "qwen3-coder",
          "ollama_fast_model": ""}
ANTHROPIC_VARIABLES = ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
                       "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                       "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL")


class FakeSession:
    def __init__(self, project_path):
        self.project_path = project_path
        self.is_running, self.exited = True, False

    def close(self):
        self.is_running, self.exited = False, True


def test_the_default_changes_nothing_the_user_set(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://gateway.example")
    assert model_provider.load() == model_provider.DEFAULTS
    assert model_provider.environment(model_provider.load()) == {}
    assert claude_cli.child_environment()["ANTHROPIC_BASE_URL"] == "https://gateway.example"


def test_ollama_points_claude_code_at_the_server_and_maps_every_alias(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-the-users-own")
    model_provider.save(OLLAMA)
    env = claude_cli.child_environment()
    assert env["ANTHROPIC_BASE_URL"] == "http://localhost:11434"  # trailing slash dropped
    assert env["ANTHROPIC_AUTH_TOKEN"] == "ollama"
    assert env["ANTHROPIC_API_KEY"] == ""  # would otherwise be sent to Ollama
    for name in model_provider.MAIN_MODEL_VARIABLES + model_provider.FAST_MODEL_VARIABLES:
        assert env[name] == "qwen3-coder", name


def test_the_fast_model_takes_the_haiku_alias():
    env = model_provider.environment(model_provider.normalize({**OLLAMA, "ollama_fast_model": "qwen3:4b"}))
    assert env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == "qwen3:4b"
    assert env["ANTHROPIC_DEFAULT_SONNET_MODEL"] == env["ANTHROPIC_MODEL"] == "qwen3-coder"


def test_switching_back_keeps_the_ollama_fields_and_adds_nothing():
    provider = model_provider.save({**OLLAMA, "kind": "anthropic"})
    assert provider["ollama_model"] == "qwen3-coder"
    assert model_provider.environment(provider) == {}


@pytest.mark.parametrize("raw, message", [
    ({**OLLAMA, "model": "x"}, "Unknown model provider fields: model"),
    ({**OLLAMA, "kind": "openai"}, "kind must be one of"),
    ({**OLLAMA, "ollama_model": ""}, "Choose the Ollama model"),
    ({**OLLAMA, "ollama_model": "qwen3 coder"}, "spaces"),
    ({**OLLAMA, "ollama_url": "localhost:11434"}, "http:// or https://"),
    ({**OLLAMA, "ollama_url": "http://localhost:11434/?a=1"}, "query"),
    ({**OLLAMA, "ollama_url": "http://localhost:port"}, "not valid"),
    ("ollama", "must be an object"),
])
def test_an_invalid_provider_is_refused_with_the_reason(raw, message):
    with pytest.raises(ValueError, match=message):
        model_provider.normalize(raw)


def test_an_invalid_stored_provider_stops_claude_from_starting_with_the_reason():
    settings.save({"model_provider": {**OLLAMA, "ollama_model": ""}})
    with pytest.raises(claude_cli.ClaudeCliError, match="Choose the Ollama model") as caught:
        claude_cli.child_environment()
    assert caught.value.kind == "config"


def test_the_panel_session_gets_the_provider(project):
    model_provider.save(OLLAMA)
    env = claude_cli.claude_session_env(str(project))
    assert env["ANTHROPIC_BASE_URL"] == "http://localhost:11434" and env["GILZACODE_PROJECT"] == str(project)


ENV_DUMP = r'''
import json, os, sys
sys.stdin.read()
names = json.loads(sys.argv[1])
with open(sys.argv[2], "w", encoding="utf-8") as out:
    json.dump({name: os.environ.get(name) for name in names}, out)
print(json.dumps({"type": "result", "is_error": False, "result": "ok"}))
'''


async def test_a_headless_call_gets_the_provider(tmp_path, monkeypatch):
    """Translate and Look up run with ``--setting-sources ""``, so only the environment reaches them."""
    script, dump = tmp_path / "dump_env.py", tmp_path / "env.json"
    script.write_text(ENV_DUMP, encoding="utf-8")
    monkeypatch.setattr(claude_cli, "find_claude", lambda: sys.executable)
    monkeypatch.setattr(claude_cli, "headless_argv", lambda exe, **kw: [
        sys.executable, str(script), json.dumps(ANTHROPIC_VARIABLES), str(dump)])
    model_provider.save(OLLAMA)
    result = await claude_cli.run_headless("hi", system_prompt="S", model="haiku")
    assert result.text == "ok"
    seen = json.loads(dump.read_text(encoding="utf-8"))
    assert seen["ANTHROPIC_BASE_URL"] == "http://localhost:11434"
    assert seen["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == "qwen3-coder"


async def test_the_endpoint_reads_and_validates(client):
    data = await (await client.get("/api/settings/model-provider")).json()
    assert data == {"provider": model_provider.DEFAULTS, "kinds": ["anthropic", "ollama"]}
    refused = await client.post("/api/settings/model-provider", json={**OLLAMA, "ollama_model": ""})
    assert refused.status == 400 and "Choose the Ollama model" in (await refused.json())["error"]
    assert model_provider.load() == model_provider.DEFAULTS  # nothing was stored


async def test_a_change_replaces_the_running_session_and_a_no_op_keeps_it(client, project):
    sessions = client.server.app[SESSIONS_KEY]
    sessions[CLAUDE_ID] = old = FakeSession(str(project))
    sessions["main"] = shell = FakeSession(str(project))

    changed = await (await client.post("/api/settings/model-provider", json=OLLAMA)).json()
    assert changed["restarted"] is True and changed["provider"]["ollama_url"] == "http://localhost:11434"
    assert not old.is_running and CLAUDE_ID not in sessions
    assert shell.is_running  # shell tabs do not run Claude Code

    sessions[CLAUDE_ID] = current = FakeSession(str(project))
    same = await (await client.post("/api/settings/model-provider", json=OLLAMA)).json()
    assert same["restarted"] is False and current.is_running


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def fake_ollama():
    """A server answering ``/api/tags`` in the shape Ollama documents."""
    tags = {"models": [
        {"name": "qwen3-coder:latest", "model": "qwen3-coder:latest", "size": 1,
         "details": {"family": "qwen3", "parameter_size": "30.5B"}},
        {"name": "gemma4:cloud", "model": "gemma4:cloud", "remote_host": "https://ollama.com:443", "details": {}},
    ]}
    async def list_tags(_request):
        return web.json_response(tags)

    app = web.Application()
    app.router.add_get("/api/tags", list_tags)
    runner = web.AppRunner(app)
    await runner.setup()
    port = _free_port()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    yield f"http://127.0.0.1:{port}"
    await runner.cleanup()


async def test_the_ollama_models_are_listed(client, fake_ollama):
    response = await client.get("/api/settings/model-provider/ollama-models", params={"url": fake_ollama + "/"})
    assert response.status == 200
    assert await response.json() == {"url": fake_ollama, "models": [
        {"name": "qwen3-coder:latest", "parameter_size": "30.5B", "remote": False},
        {"name": "gemma4:cloud", "parameter_size": "", "remote": True},
    ]}


async def test_an_absent_ollama_or_a_bad_url_is_reported(client):
    absent = await client.get("/api/settings/model-provider/ollama-models",
                              params={"url": f"http://127.0.0.1:{_free_port()}"})
    assert absent.status == 502 and (await absent.json())["kind"] == "ollama_unreachable"
    bad = await client.get("/api/settings/model-provider/ollama-models", params={"url": "ftp://x"})
    assert bad.status == 400
