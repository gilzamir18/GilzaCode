"""HTTP for the cloud backends, with Happy Eyeballs connection setup.

``urllib`` connects through :func:`socket.create_connection`, which walks the
resolved addresses strictly in order and spends the *whole* socket timeout on
each one before moving to the next. A host that resolves to several addresses
where only some are reachable therefore costs one full timeout per dead address
— and since the Drive backend reads large files, that timeout is necessarily
long (120 s). Observed on a consumer connection with partially broken IPv6
routing to Google: six of the eight ``www.googleapis.com`` AAAA records
blackholed while every A record answered in 40 ms, so the project listing hung
for minutes with no error while browsers and other sync clients on the same
machine were unaffected.

They were unaffected because they implement RFC 8305: interleave the families,
start an attempt every 250 ms, and take the first connection that completes.
This module does the same for the cloud package, and additionally bounds the
*connect* phase separately from the read phase — so a stalled address is
abandoned in seconds while a slow 100 MB download still gets its full timeout.

Only stdlib is used, for the reason given in :mod:`gilzacode.cloud.oauth`: a
packaged desktop build should not carry an HTTP stack for a handful of calls.
"""

from __future__ import annotations

import http.client
import socket
import threading
import time
import urllib.request

# Upper bound on a single address attempt. The read phase keeps the caller's
# own (much longer) timeout; this only decides how long a silent address may
# hold the request up.
CONNECT_TIMEOUT = 10.0

# RFC 8305 §5 "Connection Attempt Delay": how long one attempt gets before the
# next address is tried in parallel. 250 ms is the value the RFC recommends.
ATTEMPT_DELAY = 0.25

_SENTINEL = getattr(socket, "_GLOBAL_DEFAULT_TIMEOUT", object())


def _normalize_timeout(timeout):
    if timeout is _SENTINEL:
        return socket.getdefaulttimeout()
    if isinstance(timeout, (int, float)):
        return float(timeout)
    return None


def interleave(infos: list) -> list:
    """Order ``getaddrinfo`` results by alternating address family (RFC 8305 §4).

    Resolvers return every IPv6 address before every IPv4 one. Taking them in
    that order means a broken IPv6 path is tried exhaustively before IPv4 is
    reached at all; interleaving puts a working family within one attempt of the
    start whichever family is broken.
    """
    by_family: dict[int, list] = {}
    for info in infos:
        by_family.setdefault(info[0], []).append(info)
    queues = list(by_family.values())
    ordered = []
    while queues:
        for queue in list(queues):
            ordered.append(queue.pop(0))
            if not queue:
                queues.remove(queue)
    return ordered


class _Race:
    """Concurrent connect attempts where the first success wins."""

    def __init__(self, connect_timeout: float, source_address):
        self._connect_timeout = connect_timeout
        self._source_address = source_address
        self._lock = threading.Lock()
        self._winner = None
        self._errors: list[OSError] = []
        self._threads: list[threading.Thread] = []
        self.settled = threading.Event()

    def start(self, info) -> None:
        thread = threading.Thread(target=self._attempt, args=(info,), daemon=True)
        self._threads.append(thread)
        thread.start()

    def _attempt(self, info) -> None:
        family, sock_type, proto, _canonname, sockaddr = info
        sock = socket.socket(family, sock_type, proto)
        try:
            sock.settimeout(self._connect_timeout)
            if self._source_address:
                sock.bind(self._source_address)
            sock.connect(sockaddr)
        except OSError as exc:
            sock.close()
            with self._lock:
                self._errors.append(exc)
            return
        with self._lock:
            won = self._winner is None
            if won:
                self._winner = sock
        if won:
            self.settled.set()
        else:
            # A later arrival to an already-decided race. Closing here is what
            # keeps the losing attempts from leaking descriptors.
            sock.close()

    def result(self, deadline: float):
        while not self.settled.is_set():
            if not any(thread.is_alive() for thread in self._threads):
                break
            if time.monotonic() >= deadline:
                break
            self.settled.wait(0.05)
        with self._lock:
            if self._winner is not None:
                return self._winner
            error = self._errors[0] if self._errors else None
        raise error or TimeoutError("No address answered in time.")


def create_connection(address, timeout=_SENTINEL, source_address=None):
    """A :func:`socket.create_connection` that races addresses instead of
    walking them."""
    host, port = address[0], address[1]
    read_timeout = _normalize_timeout(timeout)
    infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    if not infos:
        raise OSError(f"No address found for {host!r}.")

    ordered = interleave(infos)
    connect_timeout = CONNECT_TIMEOUT
    if read_timeout is not None:
        connect_timeout = min(connect_timeout, read_timeout)

    race = _Race(connect_timeout, source_address)
    deadline = time.monotonic() + connect_timeout + ATTEMPT_DELAY * len(ordered)
    for index, info in enumerate(ordered):
        if index and race.settled.wait(ATTEMPT_DELAY):
            break
        race.start(info)

    sock = race.result(deadline)
    # The race only bounded the handshake; reads and writes get what the caller
    # asked for, which for an upload or a download is deliberately generous.
    sock.settimeout(read_timeout)
    return sock


class _HTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = create_connection


class _HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = create_connection


class _HTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_HTTPConnection, req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_HTTPSConnection, req, context=self._context)


_opener_lock = threading.Lock()
_opener = None


def _get_opener():
    global _opener
    with _opener_lock:
        if _opener is None:
            _opener = urllib.request.build_opener(_HTTPHandler, _HTTPSHandler)
        return _opener


def urlopen(request, timeout=_SENTINEL):
    """Drop-in :func:`urllib.request.urlopen` for the cloud package."""
    return _get_opener().open(request, timeout=timeout)
