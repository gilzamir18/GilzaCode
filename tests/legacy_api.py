"""Run tests written against GilzaBots' ``AsyncHTTPServer.route_api`` on GilzaCode's server.

The copied tests call ``server.route_api(method, path, query, headers, body, writer)``
with ``send_response`` replaced by a capture, and set ``server.last_synctex_path``.
`LegacyServer` keeps that surface but sends real HTTP requests to a running
GilzaCode server, through an authenticated client, so the copied tests exercise
the real routes and middlewares unchanged.
"""

from __future__ import annotations

import json

import pytest

from gilzacode.server.routes_latex import STATE_KEY

_current = {}


@pytest.fixture
async def legacy_client(client):
    _current["client"] = client
    yield client
    _current.pop("client", None)


class LegacyServer:
    def __init__(self, with_type: bool):
        self._client = _current["client"]
        self._with_type = with_type
        self.responses: list[tuple] = []

    @property
    def _state(self):
        return self._client.server.app[STATE_KEY]

    @property
    def last_synctex_path(self) -> str:
        return self._state.synctex_path

    @last_synctex_path.setter
    def last_synctex_path(self, value: str) -> None:
        self._state.synctex_path = value

    @property
    def last_pdf_path(self) -> str:
        return self._state.pdf_path

    @last_pdf_path.setter
    def last_pdf_path(self, value: str) -> None:
        self._state.pdf_path = value

    async def route_api(self, method, path, query, _headers, body, _writer=None):
        params = {k: (v[0] if isinstance(v, list) else v) for k, v in (query or {}).items()}
        payload = json.loads(body.decode("utf-8")) if body else None
        response = await self._client.request(method, path, params=params, json=payload)
        content_type = response.content_type
        if content_type == "application/json":
            content = await response.json()
        else:
            content = await response.read()
        self.responses.append((response.status, content, content_type) if self._with_type
                              else (response.status, content))
