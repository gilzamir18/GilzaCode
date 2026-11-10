"""Terminal scrollback buffer: what a reconnecting client gets replayed.

The GUI terminal used to come back empty whenever its xterm instance was
recreated, because the SSE stream only carried live PTY output. The session now
keeps a bounded scrollback and hands new subscribers the part they are missing.
"""
import sys

import pytest

from gilzacode import terminal_manager
from gilzacode.terminal_manager import TerminalSession


@pytest.fixture
def session(tmp_path):
    """A session object with no PTY behind it — only the buffering is exercised."""
    s = object.__new__(TerminalSession)
    s.project_path = str(tmp_path)
    s.is_running = True
    s.queues = []
    s.loop = None
    s.process = None
    s.master_fd = None
    s.slave_fd = None
    s.buffer = bytearray()
    s.total_bytes = 0
    return s


def test_new_client_gets_whole_scrollback(session):
    session._forward_data(b"hello ")
    session._forward_data(b"world")

    backlog, offset = session.backlog_since(None)

    assert backlog == b"hello world"
    assert offset == 11


def test_reconnecting_client_only_gets_what_it_missed(session):
    session._forward_data(b"first\r\n")
    _, offset = session.backlog_since(None)
    session._forward_data(b"second\r\n")

    backlog, new_offset = session.backlog_since(offset)

    assert backlog == b"second\r\n"
    assert new_offset == offset + len(b"second\r\n")


def test_up_to_date_client_gets_nothing(session):
    session._forward_data(b"output")
    _, offset = session.backlog_since(None)

    backlog, new_offset = session.backlog_since(offset)

    assert backlog == b""
    assert new_offset == offset


def test_offset_older_than_retained_buffer_replays_everything(session, monkeypatch):
    monkeypatch.setattr(terminal_manager, "SCROLLBACK_LIMIT", 8)
    session._forward_data(b"aaaaaaaaaa")  # 10 bytes, trimmed down to the last 8

    assert bytes(session.buffer) == b"aaaaaaaa"
    assert session.total_bytes == 10

    # Offset 0 predates the retained window, so the whole buffer comes back.
    backlog, offset = session.backlog_since(0)
    assert backlog == b"aaaaaaaa"
    assert offset == 10


def test_bogus_offset_from_a_restarted_session_replays_everything(session):
    session._forward_data(b"fresh")

    # A client resuming with an id from a previous, longer-lived session.
    backlog, offset = session.backlog_since(99999)

    assert backlog == b"fresh"
    assert offset == 5


def test_buffer_never_exceeds_the_limit(session, monkeypatch):
    monkeypatch.setattr(terminal_manager, "SCROLLBACK_LIMIT", 16)
    for _ in range(50):
        session._forward_data(b"0123456789")
        assert len(session.buffer) <= 16

    assert session.total_bytes == 500


def test_live_subscribers_still_receive_data(session):
    import asyncio

    q = asyncio.Queue()
    session.queues.append(q)
    session._forward_data(b"tick")

    assert q.get_nowait() == b"tick"
    assert bytes(session.buffer) == b"tick"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX pty path only")
@pytest.mark.parametrize("high_descriptor", [False, True])
def test_real_session_buffers_shell_output(tmp_path, high_descriptor):
    """End-to-end: a real PTY session records what the shell prints."""
    import asyncio

    async def run():
        term = TerminalSession(str(tmp_path))
        try:
            if high_descriptor:
                import fcntl
                import os
                import resource
                if resource.getrlimit(resource.RLIMIT_NOFILE)[0] <= 1100:
                    pytest.skip("The descriptor limit is too low for the high-FD regression.")
                descriptor = fcntl.fcntl(term.master_fd, fcntl.F_DUPFD, 1100)
                os.close(term.master_fd)
                term.master_fd = descriptor
            term.start_reading(asyncio.get_running_loop())
            term.write("echo gilzabots-scrollback-marker\n")
            for _ in range(50):
                await asyncio.sleep(0.1)
                if b"gilzabots-scrollback-marker" in bytes(term.buffer):
                    break
            backlog, offset = term.backlog_since(None)
            assert b"gilzabots-scrollback-marker" in backlog
            assert offset == len(backlog)
        finally:
            term.close()

    asyncio.run(run())


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX pty path only")
def test_reader_closes_cleanly_after_event_loop_shutdown(tmp_path):
    import asyncio

    term = TerminalSession(str(tmp_path))
    loop = asyncio.new_event_loop()
    loop.close()
    term.loop = loop
    try:
        term.write("echo shutdown-marker\n")
        # Execute the reader directly so any shutdown exception fails the test.
        term._thread_read_loop()
        assert not term.is_running
        assert term.master_fd is None
        term._thread_read_loop()  # Late/repeated shutdown is also harmless.
    finally:
        term.close()
