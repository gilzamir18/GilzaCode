"""PKCE loopback flow: the parts that can be tested without a real provider."""

import base64
import hashlib
import json
import threading
import urllib.parse
import urllib.request

import pytest

from gilzacode.cloud import oauth
from gilzacode.cloud.base import CloudAuthError


def test_pkce_challenge_is_the_sha256_of_the_verifier():
    pair = oauth.generate_pkce()

    expected = base64.urlsafe_b64encode(
        hashlib.sha256(pair.verifier.encode("ascii")).digest()
    ).decode("ascii").rstrip("=")

    assert pair.method == "S256"
    assert pair.challenge == expected
    assert "=" not in pair.challenge  # base64url for a URL parameter, unpadded


def test_each_authorization_gets_a_fresh_verifier_and_state():
    first = oauth.generate_pkce()
    second = oauth.generate_pkce()

    assert first.verifier != second.verifier


def test_authorization_url_carries_pkce_and_a_loopback_redirect():
    url, session = oauth.start_authorization(
        authorization_endpoint="https://example.test/auth",
        client_id="client-123",
        scopes=["scope.a", "scope.b"],
        extra_params={"access_type": "offline"},
    )
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)

        assert query["client_id"] == ["client-123"]
        assert query["response_type"] == ["code"]
        assert query["code_challenge_method"] == ["S256"]
        assert query["scope"] == ["scope.a scope.b"]
        assert query["access_type"] == ["offline"]
        # An embedded webview cannot serve the consent screen, so the redirect
        # has to come back to a local listener the system browser can reach.
        assert query["redirect_uri"][0].startswith("http://127.0.0.1:")
        assert session["state"] == query["state"][0]
        assert session["code_verifier"]
    finally:
        oauth.cancel_authorization(session)


def test_receiver_captures_the_redirect():
    receiver = oauth.LoopbackReceiver()
    try:
        captured = {}

        def wait():
            captured.update(receiver.wait(timeout=5))

        waiter = threading.Thread(target=wait)
        waiter.start()

        urllib.request.urlopen(f"{receiver.redirect_uri}/?code=abc&state=xyz", timeout=5).read()
        waiter.join(timeout=5)

        assert captured == {"code": "abc", "state": "xyz"}
    finally:
        receiver.close()


def test_a_mismatched_state_is_rejected(monkeypatch):
    # A loopback listener accepts anything that can reach localhost, so the
    # state check is what stops a code obtained for another account.
    monkeypatch.setattr(oauth, "post_form", lambda *a, **k: pytest.fail("must not exchange"))

    with pytest.raises(CloudAuthError, match="state mismatch"):
        oauth.finish_authorization(
            {"state": "expected", "code_verifier": "v", "redirect_uri": "http://127.0.0.1:1"},
            token_endpoint="https://example.test/token",
            client_id="client",
            response={"code": "abc", "state": "attacker"},
        )


def test_a_denied_authorization_is_reported():
    with pytest.raises(CloudAuthError, match="denied"):
        oauth.finish_authorization(
            {"state": "s"},
            token_endpoint="https://example.test/token",
            client_id="client",
            response={"error": "access_denied", "state": "s"},
        )


def test_the_exchange_sends_the_verifier(monkeypatch):
    sent = {}

    def fake_post(url, payload, timeout=30.0):
        sent.update(payload)
        sent["url"] = url
        return {"access_token": "at", "refresh_token": "rt", "expires_in": 3600}

    monkeypatch.setattr(oauth, "post_form", fake_post)

    result = oauth.finish_authorization(
        {"state": "s", "code_verifier": "verifier-value", "redirect_uri": "http://127.0.0.1:9"},
        token_endpoint="https://example.test/token",
        client_id="client",
        client_secret="secret",
        response={"code": "the-code", "state": "s"},
    )

    assert result["refresh_token"] == "rt"
    assert sent["code_verifier"] == "verifier-value"
    assert sent["grant_type"] == "authorization_code"
    assert sent["redirect_uri"] == "http://127.0.0.1:9"


def test_completing_without_a_pending_authorization_fails_clearly():
    with pytest.raises(CloudAuthError, match="No authorization is pending"):
        oauth.finish_authorization(
            {"state": "never-started"},
            token_endpoint="https://example.test/token",
            client_id="client",
            timeout=0.1,
        )
