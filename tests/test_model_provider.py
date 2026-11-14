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
    assert data == {"provider": {**model_provider.DEFAULTS, "ollama_api_key_set": False},
                    "kinds": ["anthropic", "ollama"], "ollama_cloud_url": "https://ollama.com"}
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


CLOUD = {**OLLAMA, "ollama_url": "https://ollama.com", "ollama_model": "glm-5.3"}


def test_an_api_key_is_the_bearer_token_and_stays_out_of_settings(isolated_home):
    model_provider.save({**CLOUD, "ollama_api_key": " sk-ollama-1 "})
    env = claude_cli.child_environment()
    assert env["ANTHROPIC_BASE_URL"] == "https://ollama.com"
    assert env["ANTHROPIC_AUTH_TOKEN"] == "sk-ollama-1" and env["ANTHROPIC_API_KEY"] == ""
    assert "sk-ollama-1" not in settings.settings_path().read_text(encoding="utf-8")
    assert model_provider.api_key_path().read_text(encoding="utf-8") == "sk-ollama-1"
    if sys.platform != "win32":
        assert model_provider.api_key_path().stat().st_mode & 0o077 == 0


def test_an_absent_key_field_keeps_the_key_and_an_empty_one_removes_it():
    model_provider.save({**CLOUD, "ollama_api_key": "sk-1"})
    model_provider.save({**CLOUD, "ollama_fast_model": "gemma4"})
    assert model_provider.load_api_key() == "sk-1"
    model_provider.save({**OLLAMA, "ollama_api_key": ""})
    assert model_provider.load_api_key() == "" and not model_provider.api_key_path().exists()
    assert claude_cli.child_environment()["ANTHROPIC_AUTH_TOKEN"] == "ollama"


def test_the_anthropic_provider_never_sends_the_key():
    model_provider.save({**CLOUD, "kind": "anthropic", "ollama_api_key": "sk-1"})
    assert model_provider.current_environment() == {}


def test_an_invalid_key_is_refused_before_anything_is_stored():
    with pytest.raises(ValueError, match="spaces"):
        model_provider.save({**CLOUD, "ollama_api_key": "sk 1"})
    assert model_provider.load() == model_provider.DEFAULTS and model_provider.load_api_key() == ""


async def test_the_endpoint_never_returns_the_key_and_a_new_key_restarts(client, project):
    sessions = client.server.app[SESSIONS_KEY]
    saved = await (await client.post("/api/settings/model-provider", json={**CLOUD, "ollama_api_key": "sk-1"})).json()
    assert saved["provider"]["ollama_api_key_set"] is True and "ollama_api_key" not in saved["provider"]
    read = await (await client.get("/api/settings/model-provider")).json()
    assert "sk-1" not in json.dumps(read)

    sessions[CLAUDE_ID] = old = FakeSession(str(project))
    rotated = await (await client.post("/api/settings/model-provider", json={**CLOUD, "ollama_api_key": "sk-2"})).json()
    assert rotated["restarted"] is True and not old.is_running


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def fake_ollama():
    """A server answering ``/api/tags`` in the shape Ollama documents (and ollama.com returns,
    with ``capabilities``). It records the Authorization headers it receives; with
    ``required_key`` set it refuses requests without that key, as ollama.com does."""
    tags = {"models": [
        {"name": "qwen3-coder:latest", "model": "qwen3-coder:latest", "size": 1,
         "details": {"family": "qwen3", "parameter_size": "30.5B"}},
        {"name": "gemma4:cloud", "model": "gemma4:cloud", "remote_host": "https://ollama.com:443", "details": {},
         "capabilities": ["completion", "tools"]},
        {"name": "embed", "model": "embed", "details": {}, "capabilities": ["embedding"]},
    ]}
    state = {"auth": [], "required_key": ""}

    async def list_tags(request):
        state["auth"].append(request.headers.get("Authorization"))
        if state["required_key"] and request.headers.get("Authorization") != f"Bearer {state['required_key']}":
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.json_response(tags)

    app = web.Application()
    app.router.add_get("/api/tags", list_tags)
    runner = web.AppRunner(app)
    await runner.setup()
    port = _free_port()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    state["url"] = f"http://127.0.0.1:{port}"
    yield state
    await runner.cleanup()


LIST = "/api/settings/model-provider/ollama-models"


async def test_the_ollama_models_are_listed(client, fake_ollama):
    url = fake_ollama["url"]
    response = await client.post(LIST, json={"url": url + "/"})
    assert response.status == 200
    assert await response.json() == {"url": url, "models": [
        {"name": "qwen3-coder:latest", "parameter_size": "30.5B", "remote": False, "tools": None},
        {"name": "gemma4:cloud", "parameter_size": "", "remote": True, "tools": True},
        {"name": "embed", "parameter_size": "", "remote": False, "tools": False},
    ]}
    assert fake_ollama["auth"] == [None]  # no key, no header


async def test_the_stored_key_goes_only_to_the_url_it_was_saved_with(client, fake_ollama):
    url = fake_ollama["url"]
    fake_ollama["required_key"] = "sk-1"
    model_provider.save({**CLOUD, "ollama_url": url, "ollama_api_key": "sk-1"})
    assert (await client.post(LIST, json={"url": url})).status == 200
    assert fake_ollama["auth"] == ["Bearer sk-1"]

    model_provider.save({**CLOUD, "ollama_url": "https://ollama.com"})  # the key now belongs to ollama.com
    refused = await client.post(LIST, json={"url": url})
    body = await refused.json()
    assert refused.status == 502 and body["kind"] == "ollama_unauthorized" and "needs an API key" in body["error"]
    assert fake_ollama["auth"][-1] is None


async def test_a_typed_key_is_used_and_a_wrong_one_is_reported(client, fake_ollama):
    fake_ollama["required_key"] = "sk-right"
    wrong = await client.post(LIST, json={"url": fake_ollama["url"], "api_key": "sk-wrong"})
    assert wrong.status == 502 and "Check the API key" in (await wrong.json())["error"]
    right = await client.post(LIST, json={"url": fake_ollama["url"], "api_key": "sk-right"})
    assert right.status == 200


async def test_an_absent_ollama_or_a_bad_url_is_reported(client):
    absent = await client.post(LIST, json={"url": f"http://127.0.0.1:{_free_port()}"})
    assert absent.status == 502 and (await absent.json())["kind"] == "ollama_unreachable"
    bad = await client.post(LIST, json={"url": "ftp://x"})
    assert bad.status == 400
