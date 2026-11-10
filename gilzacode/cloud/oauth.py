"""OAuth 2.0 Authorization Code + PKCE over a loopback redirect.

Provider-neutral: the endpoints, scopes and client credentials are all supplied
by the caller, so a second OAuth backend reuses this module unchanged.

Two constraints shaped the design.

*The system browser is mandatory.* GilzaCode renders its UI inside an embedded
webview (pywebview/QtWebEngine), and Google — like most identity providers —
refuses to serve its consent screen to embedded user agents. The authorization
URL therefore has to be handed to the desktop's default browser.

*The client secret is not a secret.* A desktop application ships its
credentials to every user, so the flow is protected by PKCE (RFC 7636) rather
than by the secret. The secret is still sent when the provider requires one,
because Google's token endpoint rejects the exchange without it for clients
registered before PKCE-only support.

Only stdlib is used. Adding an HTTP or OAuth library for this would pull a large
dependency tree into a packaged desktop build for a few hundred lines of work.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Optional

from . import transport
from .base import CloudAuthError, CloudTransientError

# How long the loopback listener waits for the user to finish in the browser.
DEFAULT_AUTH_TIMEOUT = 300.0

_SUCCESS_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>GilzaCode</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#1e1e1e;color:#e6e6e6;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:32rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#a0a0a0;margin:0;line-height:1.5}
</style></head><body><div class="card">
<h1>GilzaCode is connected</h1>
<p>Authorization completed. You can close this tab and return to GilzaCode.</p>
</div></body></html>"""

_FAILURE_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>GilzaCode</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#1e1e1e;color:#e6e6e6;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:32rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .5rem;color:#f48771}p{color:#a0a0a0;margin:0;line-height:1.5}
</style></head><body><div class="card">
<h1>Authorization failed</h1><p>%s</p>
</div></body></html>"""


@dataclass
class PkcePair:
    verifier: str
    challenge: str
    method: str = "S256"


def generate_pkce() -> PkcePair:
    """Create a PKCE verifier/challenge pair (RFC 7636 §4.1-4.2)."""
    verifier = base64.urlsafe_b64encode(os.urandom(64)).decode("ascii").rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return PkcePair(verifier=verifier, challenge=challenge)


class _RedirectHandler(BaseHTTPRequestHandler):
    # Set by the receiver before the server starts.
    receiver: "LoopbackReceiver" = None  # type: ignore[assignment]

    def do_GET(self):  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        parsed = urllib.parse.urlparse(self.path)
        params = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        if "state" not in params and parsed.path.startswith("/callback/"):
            path_state = urllib.parse.unquote(parsed.path[len("/callback/"):].strip("/"))
            if path_state:
                params["state"] = path_state
        if "code" not in params and "error" not in params:
            # Browsers request /favicon.ico and similar on the same origin;
            # answering 404 keeps those out of the result.
            self.send_error(404)
            return
        self.receiver.deliver(params)
        error = params.get("error", "")
        body = (_FAILURE_PAGE % _escape(error)) if error else _SUCCESS_PAGE
        encoded = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *args):
        # The default handler prints every request to stderr, which in a
        # packaged --windowed build goes nowhere useful and in a terminal build
        # dumps the authorization code where it does not belong.
        return


def _escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


class LoopbackReceiver:
    """A one-shot HTTP listener on 127.0.0.1 that captures the OAuth redirect.

    Binds an ephemeral port by default: the provider's registered redirect URI
    is ``http://127.0.0.1`` with any port, and a fixed port would collide with
    whatever else the machine is running. A caller whose provider matches the
    redirect URI exactly, port included, passes ``port`` instead; binding then
    raises ``OSError`` when that port is taken, so the caller can try another.
    """

    def __init__(self, port: int = 0):
        self.created_at = time.monotonic()
        handler = type("_Handler", (_RedirectHandler,), {"receiver": self})
        self._server = HTTPServer(("127.0.0.1", int(port)), handler)
        self._server.timeout = 1.0
        self._event = threading.Event()
        self._params: dict[str, str] = {}
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True
        )
        self._thread.start()

    @property
    def port(self) -> int:
        return self._server.server_address[1]

    @property
    def redirect_uri(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def deliver(self, params: dict[str, str]) -> None:
        self._params = params
        self._event.set()

    def wait(self, timeout: float = DEFAULT_AUTH_TIMEOUT) -> dict[str, str]:
        if not self._event.wait(timeout):
            self.close()
            raise CloudAuthError(
                "Timed out waiting for the authorization to complete in the browser."
            )
        return dict(self._params)

    def close(self) -> None:
        try:
            self._server.shutdown()
        except Exception:
            pass
        try:
            self._server.server_close()
        except Exception:
            pass


# Live receivers, keyed by the CSRF `state` value. `begin_authorization` returns
# a plain dict through the provider facade, so the listener itself — which owns a
# socket and a thread — is parked here until the matching completion call.
_PENDING: dict[str, LoopbackReceiver] = {}
_PENDING_LOCK = threading.Lock()


def _reap_expired_receivers(max_age: float = DEFAULT_AUTH_TIMEOUT) -> None:
    """Close and evict loopback listeners that outlived the authorization window."""
    now = time.monotonic()
    expired: list[LoopbackReceiver] = []
    with _PENDING_LOCK:
        stale_states = [
            st
            for st, rec in _PENDING.items()
            if (now - getattr(rec, "created_at", now)) > max_age
        ]
        for st in stale_states:
            rec = _PENDING.pop(st, None)
            if rec is not None:
                expired.append(rec)
    for rec in expired:
        rec.close()


def register_pending_receiver(state: str, receiver: LoopbackReceiver) -> None:
    """Register a live loopback listener under its CSRF `state` after reaping stale ones."""
    _reap_expired_receivers()
    with _PENDING_LOCK:
        _PENDING[state] = receiver


def pop_pending_receiver(state: str) -> Optional[LoopbackReceiver]:
    """Atomically claim and remove a pending loopback listener by `state`."""
    with _PENDING_LOCK:
        return _PENDING.pop(state, None)


def start_authorization(
    *,
    authorization_endpoint: str,
    client_id: str,
    scopes: list[str],
    extra_params: Optional[dict[str, str]] = None,
) -> tuple[str, dict]:
    """Open a loopback listener and build the URL the user must visit.

    Returns ``(authorization_url, session)``. The session is opaque to callers
    and must be handed back to :func:`finish_authorization`.
    """
    _reap_expired_receivers()
    receiver = LoopbackReceiver()
    state = secrets.token_urlsafe(24)
    pkce = generate_pkce()
    with _PENDING_LOCK:
        _PENDING[state] = receiver

    params = {
        "client_id": client_id,
        "redirect_uri": receiver.redirect_uri,
        "response_type": "code",
        "scope": " ".join(scopes),
        "state": state,
        "code_challenge": pkce.challenge,
        "code_challenge_method": pkce.method,
    }
    params.update(extra_params or {})
    url = f"{authorization_endpoint}?{urllib.parse.urlencode(params)}"
    session = {
        "state": state,
        "code_verifier": pkce.verifier,
        "redirect_uri": receiver.redirect_uri,
        "scopes": list(scopes),
    }
    return url, session


def open_in_browser(url: str) -> bool:
    """Hand the URL to the desktop's default browser.

    Returns False when no browser could be launched — a headless session, or a
    confined sandbox without a portal — so the caller can fall back to showing
    the URL for the user to open manually instead of leaving them staring at a
    dialog that never proceeds.
    """
    try:
        return bool(webbrowser.open(url, new=1, autoraise=True))
    except Exception:
        return False


def finish_authorization(
    session: dict,
    *,
    token_endpoint: str,
    client_id: str,
    client_secret: str = "",
    response: Optional[dict] = None,
    timeout: float = DEFAULT_AUTH_TIMEOUT,
) -> dict:
    """Wait for the redirect (or accept a pre-delivered `response`) and exchange
    the authorization code for tokens."""
    state = str(session.get("state", ""))
    params = dict(response or {})
    if not params:
        with _PENDING_LOCK:
            receiver = _PENDING.get(state)
        if receiver is None:
            raise CloudAuthError(
                "No authorization is pending. Start the connection again."
            )
        try:
            params = receiver.wait(timeout)
        finally:
            receiver.close()
            with _PENDING_LOCK:
                _PENDING.pop(state, None)

    if params.get("error"):
        raise CloudAuthError(f"Authorization was denied: {params['error']}")
    # The state check is what stops a third party from feeding us a code
    # obtained for a different account; a loopback listener accepts anything
    # that can reach localhost.
    if params.get("state") != state:
        raise CloudAuthError("Authorization state mismatch; the response was discarded.")
    code = params.get("code", "")
    if not code:
        raise CloudAuthError("The authorization response carried no code.")

    payload = {
        "code": code,
        "client_id": client_id,
        "redirect_uri": session.get("redirect_uri", ""),
        "grant_type": "authorization_code",
        "code_verifier": session.get("code_verifier", ""),
    }
    if client_secret:
        payload["client_secret"] = client_secret
    return post_form(token_endpoint, payload)


def cancel_authorization(session: dict) -> None:
    """Tear down a pending listener when the user backs out of the dialog."""
    state = str(session.get("state", ""))
    with _PENDING_LOCK:
        receiver = _PENDING.pop(state, None)
    if receiver is not None:
        receiver.close()


def refresh_access_token(
    *,
    token_endpoint: str,
    client_id: str,
    refresh_token: str,
    client_secret: str = "",
) -> dict:
    payload = {
        "client_id": client_id,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    if client_secret:
        payload["client_secret"] = client_secret
    return post_form(token_endpoint, payload)


def revoke_token(revocation_endpoint: str, token: str) -> None:
    """Best-effort revocation. A failure here must not block local sign-out."""
    try:
        post_form(revocation_endpoint, {"token": token})
    except Exception:
        pass


def post_form(url: str, payload: dict[str, str], timeout: float = 30.0) -> dict:
    """POST an ``application/x-www-form-urlencoded`` body and parse JSON back."""
    body = urllib.parse.urlencode(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    try:
        with transport.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = _read_error(exc)
        # 400/401 from a token endpoint means the grant is bad (revoked refresh
        # token, wrong client, replayed code). Retrying cannot fix it, so it is
        # reported as an auth failure rather than a transient one.
        if exc.code in (400, 401):
            raise CloudAuthError(f"Token request rejected: {detail}") from exc
        raise CloudTransientError(f"Token request failed ({exc.code}): {detail}") from exc
    except urllib.error.URLError as exc:
        raise CloudTransientError(f"Could not reach the authorization server: {exc.reason}") from exc


def post_json(url: str, payload: dict[str, Any], timeout: float = 30.0) -> dict:
    """POST an ``application/json`` body and parse JSON back."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with transport.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = _read_error(exc)
        if exc.code in (400, 401, 403):
            raise CloudAuthError(f"Token request rejected: {detail}") from exc
        raise CloudTransientError(f"Token request failed ({exc.code}): {detail}") from exc
    except urllib.error.URLError as exc:
        raise CloudTransientError(f"Could not reach the authorization server: {exc.reason}") from exc


def _read_error(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", "replace")
    except Exception:
        return exc.reason or str(exc.code)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw[:400]
    if isinstance(parsed, dict):
        err = parsed.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or err.get("description")
            if msg:
                return str(msg)
        description = parsed.get("error_description") or err or parsed.get("message") or raw[:400]
        return str(description)
    return raw[:400]
