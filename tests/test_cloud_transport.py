"""Happy Eyeballs connection setup for the cloud backends.

The regression these cover: a host whose IPv6 records blackhole while its IPv4
records answer normally. Walking the addresses in resolver order spends the
whole socket timeout on each dead one, which is how the Drive project listing
came to hang for minutes instead of failing or falling back.
"""

import socket
import threading
import time
import types

import pytest

from gilzacode.cloud import transport


V6_DEAD = "2001:db8::1"
V6_ALIVE = "2001:db8::2"
V4_ALIVE = "192.0.2.10"
V4_OTHER = "192.0.2.11"


def _info(family, host):
    return (family, socket.SOCK_STREAM, 6, "", (host, 443))


class _FakeSocket:
    """A socket whose connect outcome is decided per address by `behavior`."""

    def __init__(self, family, sock_type, proto, behavior, opened):
        self.family = family
        self.timeout = None
        self.closed = False
        self._behavior = behavior
        opened.append(self)

    def settimeout(self, value):
        self.timeout = value

    def bind(self, address):
        self.bound = address

    def connect(self, sockaddr):
        outcome = self._behavior.get(sockaddr[0], "ok")
        if outcome == "ok":
            self.peer = sockaddr[0]
            return
        if outcome == "refused":
            raise ConnectionRefusedError(f"refused {sockaddr[0]}")
        # "hang": silently absorb the packets until the attempt's own timeout,
        # which is what a blackholed route actually does.
        time.sleep(self.timeout if self.timeout else 0.2)
        raise TimeoutError(f"timed out {sockaddr[0]}")

    def close(self):
        self.closed = True


@pytest.fixture
def fake_net(monkeypatch):
    """Replace the module's socket access and shrink the RFC 8305 delays."""
    monkeypatch.setattr(transport, "CONNECT_TIMEOUT", 0.5)
    monkeypatch.setattr(transport, "ATTEMPT_DELAY", 0.05)

    state = types.SimpleNamespace(infos=[], behavior={}, opened=[])

    shim = types.SimpleNamespace(
        AF_INET=socket.AF_INET,
        AF_INET6=socket.AF_INET6,
        SOCK_STREAM=socket.SOCK_STREAM,
        getdefaulttimeout=socket.getdefaulttimeout,
        getaddrinfo=lambda *a, **k: list(state.infos),
        socket=lambda family, sock_type, proto: _FakeSocket(
            family, sock_type, proto, state.behavior, state.opened
        ),
    )
    monkeypatch.setattr(transport, "socket", shim)
    return state


def test_interleave_alternates_families():
    infos = [
        _info(socket.AF_INET6, "2001:db8::1"),
        _info(socket.AF_INET6, "2001:db8::2"),
        _info(socket.AF_INET6, "2001:db8::3"),
        _info(socket.AF_INET, "192.0.2.1"),
        _info(socket.AF_INET, "192.0.2.2"),
    ]
    families = [info[0] for info in transport.interleave(infos)]
    assert families == [
        socket.AF_INET6,
        socket.AF_INET,
        socket.AF_INET6,
        socket.AF_INET,
        socket.AF_INET6,
    ]


def test_interleave_keeps_a_single_family_in_order():
    infos = [_info(socket.AF_INET, "192.0.2.1"), _info(socket.AF_INET, "192.0.2.2")]
    assert transport.interleave(infos) == infos


def test_blackholed_ipv6_does_not_delay_the_ipv4_fallback(fake_net):
    """The failure that motivated the module: dead AAAA, healthy A."""
    fake_net.infos = [
        _info(socket.AF_INET6, V6_DEAD),
        _info(socket.AF_INET, V4_ALIVE),
    ]
    fake_net.behavior = {V6_DEAD: "hang", V4_ALIVE: "ok"}

    started = time.monotonic()
    sock = transport.create_connection(("example.test", 443), timeout=120)
    elapsed = time.monotonic() - started

    assert sock.peer == V4_ALIVE
    # The dead address alone would have cost CONNECT_TIMEOUT (0.5 s here, 120 s
    # in the real client). Racing means the working address decides the call.
    assert elapsed < 0.4, f"fell back only after waiting {elapsed:.2f}s"


def test_every_ipv6_dead_still_connects(fake_net):
    """Six of eight AAAA blackholed is what the reporting machine actually had."""
    fake_net.infos = [
        _info(socket.AF_INET6, f"2001:db8::{n}") for n in range(1, 7)
    ] + [_info(socket.AF_INET, V4_ALIVE)]
    fake_net.behavior = {f"2001:db8::{n}": "hang" for n in range(1, 7)}
    fake_net.behavior[V4_ALIVE] = "ok"

    started = time.monotonic()
    sock = transport.create_connection(("example.test", 443), timeout=120)
    elapsed = time.monotonic() - started

    assert sock.peer == V4_ALIVE
    assert elapsed < 0.5


def test_caller_timeout_applies_to_reads_not_to_connect(fake_net):
    fake_net.infos = [_info(socket.AF_INET, V4_ALIVE)]
    fake_net.behavior = {V4_ALIVE: "ok"}

    sock = transport.create_connection(("example.test", 443), timeout=120)

    # The connect phase was bounded by CONNECT_TIMEOUT, but a long download
    # must keep the generous read timeout it asked for.
    assert sock.timeout == 120


def test_connect_timeout_never_exceeds_a_shorter_caller_timeout(fake_net):
    fake_net.infos = [_info(socket.AF_INET, V4_ALIVE)]
    fake_net.behavior = {V4_ALIVE: "ok"}

    sock = transport.create_connection(("example.test", 443), timeout=0.1)

    assert sock.timeout == 0.1


def test_all_addresses_failing_raises_the_first_error(fake_net):
    fake_net.infos = [
        _info(socket.AF_INET6, V6_DEAD),
        _info(socket.AF_INET, V4_ALIVE),
    ]
    fake_net.behavior = {V6_DEAD: "refused", V4_ALIVE: "refused"}

    with pytest.raises(OSError):
        transport.create_connection(("example.test", 443), timeout=120)


def test_no_addresses_raises(fake_net):
    fake_net.infos = []
    with pytest.raises(OSError):
        transport.create_connection(("example.test", 443), timeout=120)


def test_losing_attempts_are_closed(fake_net):
    """A second address that connects after the race is decided must not leak."""
    fake_net.infos = [
        _info(socket.AF_INET6, V6_ALIVE),
        _info(socket.AF_INET, V4_OTHER),
    ]
    fake_net.behavior = {V6_ALIVE: "ok", V4_OTHER: "ok"}

    sock = transport.create_connection(("example.test", 443), timeout=120)

    # The winner started first and is the one handed back; anything else that
    # was opened has to have been closed.
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline and any(
        s is not sock and not s.closed for s in fake_net.opened
    ):
        time.sleep(0.02)
    leaked = [s for s in fake_net.opened if s is not sock and not s.closed]
    assert not leaked
    assert not sock.closed


def test_cloud_backends_use_this_transport():
    """The plumbing is only a fix if the callers actually route through it."""
    from gilzacode.cloud import oauth
    from gilzacode.cloud.providers import google_drive

    assert oauth.transport is transport
    assert google_drive.transport is transport


def test_concurrent_connections_share_one_opener(fake_net):
    """The opener is built once; passes run from several worker threads."""
    fake_net.infos = [_info(socket.AF_INET, V4_ALIVE)]
    fake_net.behavior = {V4_ALIVE: "ok"}

    seen = []

    def grab():
        seen.append(transport._get_opener())

    threads = [threading.Thread(target=grab) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(seen) == 8
    assert all(opener is seen[0] for opener in seen)
