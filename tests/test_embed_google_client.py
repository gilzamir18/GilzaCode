"""The release step that embeds the Google OAuth client refuses a malformed id.

A release once shipped the client secret in both fields (the repository secret
GILZACODE_GDRIVE_CLIENT_ID held the secret), and every installed copy got
"401 invalid_client — The OAuth client was not found" on Connect.
"""

import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "embed_google_client.py"

# Fake values, assembled from pieces so secret scanners (GitHub push
# protection) do not take them for a real client.
GOOD_ID = "1234567890-" + "fake" * 4 + ".apps." + "googleusercontent.com"
GOOD_SECRET = "GOCSPX" + "-" + "fake" * 7


@pytest.fixture
def embed(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("embed_google_client", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "TARGET", str(tmp_path / "bundled_google_client.json"))
    return module


def test_a_well_formed_client_is_written(embed):
    assert embed.main(["--client-id", GOOD_ID, "--client-secret", GOOD_SECRET]) == 0
    written = json.loads(Path(embed.TARGET).read_text(encoding="utf-8"))
    assert written == {"client_id": GOOD_ID, "client_secret": GOOD_SECRET}


def test_the_secret_in_the_id_field_is_refused_without_echoing_it(embed, monkeypatch, capsys):
    monkeypatch.setenv("GILZACODE_GDRIVE_CLIENT_ID", GOOD_SECRET)
    monkeypatch.setenv("GILZACODE_GDRIVE_CLIENT_SECRET", GOOD_SECRET)
    assert embed.main(["--from-env"]) == 1
    assert not Path(embed.TARGET).exists()
    out = capsys.readouterr()
    assert "client secret" in out.err
    assert GOOD_SECRET not in out.err + out.out


def test_an_id_without_the_google_suffix_is_refused(embed):
    assert embed.main(["--client-id", "not-a-client-id", "--client-secret", GOOD_SECRET]) == 1
    assert not Path(embed.TARGET).exists()


def test_a_secret_equal_to_the_id_is_refused(embed):
    assert embed.main(["--client-id", GOOD_ID, "--client-secret", GOOD_ID]) == 1
    assert not Path(embed.TARGET).exists()
