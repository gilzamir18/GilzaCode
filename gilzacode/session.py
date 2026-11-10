"""The local session boundary of the loopback server.

Ported from GilzaBots (``local_auth.py``, design §2.1). Every request must
come from this server's own origin: Host, Origin and Fetch Metadata are checked
before anything is read, and every ``/api/*`` call needs a random per-process
cookie. The page obtains it through a same-origin ``POST /api/session``
carrying a custom header, which a foreign page cannot send without a CORS
preflight that is never granted.

Other local processes that need the API (the MCP bridge Claude Code starts)
cannot use the browser cookie. They authenticate with a bearer token the
application writes to a file only the user can read (`write_connection_file`).
"""

from __future__ import annotations

import json
import os
import secrets
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit

from gilzacode.paths import gilzacode_home, write_text_atomic

BOOTSTRAP_HEADER = "x-gilzacode-bootstrap"


class LocalSession:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.token = secrets.token_urlsafe(32)
        self.bridge_token = secrets.token_urlsafe(32)

    @property
    def cookie_name(self) -> str:
        # Cookies are not port-scoped; keep simultaneous instances apart.
        return f"gilzacode_session_{self.port}"

    def cookie_header(self) -> str:
        return f"{self.cookie_name}={self.token}; Path=/api/; HttpOnly; SameSite=Strict"

    def trusted_request(self, headers) -> bool:
        """Reject foreign hosts and origins before reading a body or issuing a cookie."""
        host = headers.get("host", "")
        try:
            authority = urlsplit("http://" + host)
            allowed_hosts = {"localhost", "127.0.0.1", "::1"}
            if self.host not in {"0.0.0.0", "::"}:
                allowed_hosts.add(self.host)
            if (authority.hostname not in allowed_hosts or authority.port != self.port
                    or authority.username or authority.password or authority.path
                    or authority.query or authority.fragment):
                return False
            origin = headers.get("origin")
            if origin is not None:
                parsed = urlsplit(origin)
                if (parsed.scheme != "http" or parsed.netloc != authority.netloc
                        or parsed.path or parsed.query or parsed.fragment):
                    return False
        except ValueError:
            return False
        # Same-site is weaker than same-origin (another localhost port is
        # same-site). Media GETs often omit Origin, so check Fetch Metadata too.
        return headers.get("sec-fetch-site", "none") in {"none", "same-origin"}

    def authenticated(self, headers) -> bool:
        """The browser's session cookie, or the bridge's bearer token."""
        auth = headers.get("authorization", "")
        if auth.startswith("Bearer ") and secrets.compare_digest(auth[7:], self.bridge_token):
            return True
        try:
            cookies = SimpleCookie()
            cookies.load(headers.get("cookie", ""))
            cookie = cookies.get(self.cookie_name)
            return cookie is not None and secrets.compare_digest(cookie.value, self.token)
        except (CookieError, TypeError, ValueError):
            return False


def connection_file() -> Path:
    return gilzacode_home() / "connection.json"


def write_connection_file(session: LocalSession) -> Path:
    """Record where the running application listens and the bridge's token.

    The file sits in the user's own profile (``~/.gilzacode``), which other
    users cannot read by default on Windows.
    """
    path = connection_file()
    address = "127.0.0.1" if session.host in {"0.0.0.0", "::"} else session.host
    write_text_atomic(path, json.dumps({
        "url": f"http://{address}:{session.port}",
        "token": session.bridge_token,
        "pid": os.getpid(),
    }, indent=2))
    return path


def remove_connection_file(session: LocalSession) -> None:
    """Remove the connection file if it still belongs to `session`."""
    path = connection_file()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("token") == session.bridge_token:
            path.unlink()
    except (OSError, ValueError):
        pass
