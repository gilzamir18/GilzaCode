"""The integrated terminal: a PTY per session (winpty on Windows), copied from GilzaBots."""
import os
import re
import sys
import subprocess
import asyncio
import threading
import time
import selectors

from .external_tools import environment_with_managed_tools

# Maximum amount of raw PTY output kept in memory per session so that a client
# that reconnects (tab switch, React remount, dropped SSE stream) can restore
# the visible scrollback instead of showing an empty terminal.
SCROLLBACK_LIMIT = 256 * 1024


# Escape sequences a shell and its programs write to the PTY: OSC (window title,
# hyperlinks, cwd reports), CSI (colours, cursor moves, erase, private modes such
# as bracketed paste) and the remaining two-byte escapes.
_ESCAPE_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def screen_text(data: bytes) -> str:
    """The lines a terminal shows for raw PTY output, as plain text.

    Colours and cursor sequences are dropped. A carriage return rewinds the
    line, so a progress bar redrawn in place reads as its last state rather than
    as every frame glued together; a backspace erases the character before it.
    The scrollback is a rolling window, so a sequence cut at its start is only
    lost text, never an error.
    """
    text = _ESCAPE_RE.sub("", data.decode("utf-8", errors="replace"))
    lines = []
    for raw in text.split("\n"):
        cells: list[str] = []
        for segment in raw.rstrip("\r").split("\r"):
            drawn: list[str] = []
            for char in segment:
                if char == "\b":
                    if drawn:
                        drawn.pop()
                elif char == "\t" or not _CONTROL_RE.match(char):
                    drawn.append(char)
            cells = drawn + cells[len(drawn):]
        lines.append("".join(cells).rstrip())
    return "\n".join(lines)


def enable_ctrl_c_for_children():
    """Make sure the Windows shell we spawn will honour Ctrl+C.

    ConPTY turns the ``\\x03`` typed into the terminal into a CTRL_C_EVENT, but a
    process ignores that event when its "ignore Ctrl+C" console flag is set, and
    the flag is inherited from the process that created it. GilzaCode gets the
    flag whenever it was started in a new process group (as the in-app restart
    used to do, or as any launcher may), and PowerShell then kept running
    whatever command was in progress. Clearing it here restores the default
    every console program expects. Returns True when the flag was cleared.
    """
    if sys.platform != "win32":
        return False
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    if kernel32.SetConsoleCtrlHandler(None, False):
        return True
    print(f"[Terminal] could not enable Ctrl+C for the shell "
          f"(SetConsoleCtrlHandler failed, error {ctypes.get_last_error()})")
    return False


class TerminalSession:
    def __init__(self, project_path, argv=None, env=None):
        """A PTY running `argv` in `project_path` (default: the platform shell).

        `env` defaults to this process' environment with the managed tools on PATH.
        """
        self.project_path = project_path
        self.is_running = True
        self.queues = []
        self.loop = None
        self.process = None
        self.master_fd = None
        self.slave_fd = None
        # Rolling scrollback buffer plus the total number of bytes ever emitted
        # by this session. `total_bytes` is the stream offset of the end of the
        # buffer and is used as the SSE event id, so a reconnecting client can
        # ask for "everything after offset N" via Last-Event-ID.
        self.buffer = bytearray()
        self.total_bytes = 0
        self.argv = list(argv) if argv else None
        self.started_at = time.monotonic()
        self.last_output_at = self.started_at
        self.exited = False
        # The program ended by itself (`exit`, `/exit`), as opposed to being
        # closed by the server (a restart, a project switch, a deleted folder).
        self.ended_by_itself = False

        if sys.platform == "win32":
            try:
                from winpty import PtyProcess
                enable_ctrl_c_for_children()
                # Force PowerShell on Windows
                command = self.argv or "powershell.exe"
                self.process = PtyProcess.spawn(command, cwd=project_path,
                                                env=env if env is not None else environment_with_managed_tools())
            except ImportError:
                self.process = None
        else:
            # Unix implementation
            import pty
            import fcntl
            self.master_fd, self.slave_fd = pty.openpty()
            
            fl = fcntl.fcntl(self.master_fd, fcntl.F_GETFL)
            fcntl.fcntl(self.master_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
            
            env = dict(env) if env is not None else environment_with_managed_tools()
            env["TERM"] = "xterm-256color"
            self.process = subprocess.Popen(
                self.argv or ["/bin/bash"],
                preexec_fn=os.setsid,
                stdin=self.slave_fd,
                stdout=self.slave_fd,
                stderr=self.slave_fd,
                cwd=project_path,
                env=env
            )
            os.close(self.slave_fd)
            self.slave_fd = None

    def start_reading(self, loop):
        self.loop = loop
        if sys.platform == "win32" and self.process is None:
            msg = "\r\n\x1b[31m[GilzaCode] The terminal needs the pywinpty package: pip install pywinpty\x1b[0m\r\n"
            self._forward_data(msg.encode('utf-8'))
            return

        # Start a background daemon thread to read from PTY
        t = threading.Thread(target=self._thread_read_loop, daemon=True)
        t.start()

    def _thread_read_loop(self):
        selector = None
        try:
            if not self.is_running:
                return
            if sys.platform != "win32":
                # select.select cannot handle descriptors >= FD_SETSIZE, even
                # when only one PTY is watched. epoll/kqueue/poll can.
                selector = selectors.DefaultSelector()
                selector.register(self.master_fd, selectors.EVENT_READ)
            while self.is_running:
                if sys.platform == "win32":
                    try:
                        data_str = self.process.read(4096)
                    except (ConnectionAbortedError, EOFError, OSError):
                        # WinError 10053 and similar: terminal closed normally
                        break
                    if not data_str:
                        break
                    data = data_str.encode('utf-8')
                else:
                    try:
                        if not selector.select(0.5):
                            continue
                        data = os.read(self.master_fd, 4096)
                        if not data:
                            break
                    except (BlockingIOError, InterruptedError):
                        continue
                    except Exception:
                        break

                if self.loop and self.is_running:
                    try:
                        self.loop.call_soon_threadsafe(self._forward_data, data)
                    except RuntimeError:
                        if self.loop.is_closed():
                            break
                        raise
        except Exception as e:
            # Only log unexpected errors, not normal close-related ones
            err_str = str(e)
            if "10053" not in err_str and "ConnectionAbortedError" not in err_str:
                import traceback
                print(f"[Terminal] Read loop error: {e}\n{traceback.format_exc()}")
        finally:
            if selector is not None:
                selector.close()
            if self.is_running:
                self.ended_by_itself = True
                if self.loop:
                    try:
                        self.loop.call_soon_threadsafe(self.close)
                    except RuntimeError:
                        if not self.loop.is_closed():
                            raise
                        self.close()
                else:
                    self.close()

    def _forward_data(self, data):
        self.last_output_at = time.monotonic()
        self._append_to_buffer(data)
        for q in list(self.queues):
            q.put_nowait(data)

    def _append_to_buffer(self, data):
        self.buffer.extend(data)
        self.total_bytes += len(data)
        if len(self.buffer) > SCROLLBACK_LIMIT:
            del self.buffer[:len(self.buffer) - SCROLLBACK_LIMIT]

    def backlog_since(self, last_offset=None):
        """Return (bytes_to_replay, end_offset) for a (re)connecting client.

        `last_offset` is the stream offset the client already received (the SSE
        Last-Event-ID). Only the part of the scrollback after that offset is
        returned; when it is None, unusable, or older than what is still
        retained, the whole retained buffer is replayed instead.

        Callers MUST subscribe their queue and call this without awaiting in
        between, so no chunk is lost or duplicated at the hand-off point.
        """
        buffered_from = self.total_bytes - len(self.buffer)
        if last_offset is not None and buffered_from <= last_offset <= self.total_bytes:
            start = last_offset - buffered_from
        else:
            start = 0
        return bytes(self.buffer[start:]), self.total_bytes

    def write(self, data):
        if not self.is_running or not self.process:
            return
        try:
            if sys.platform == "win32":
                self.process.write(data)
            else:
                if self.master_fd is not None:
                    os.write(self.master_fd, data.encode('utf-8'))
        except Exception as e:
            print(f"[Terminal] write error: {e}")

    def resize(self, cols, rows):
        if not self.is_running or not self.process:
            return
        try:
            if sys.platform == "win32":
                self.process.setwinsize(rows, cols)
            else:
                if self.master_fd is not None:
                    import termios
                    import struct
                    import fcntl
                    s = struct.pack('HHHH', rows, cols, 0, 0)
                    fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, s)
        except Exception as e:
            print(f"[Terminal] resize error: {e}")

    def close(self):
        if not self.is_running:
            return
        self.is_running = False
        self.exited = True
        
        if sys.platform == "win32":
            if self.process:
                try:
                    self.process.close()
                except:
                    pass
                self.process = None
        else:
            if self.master_fd is not None:
                try:
                    os.close(self.master_fd)
                except Exception:
                    pass
                self.master_fd = None
                
            if self.process:
                try:
                    import signal
                    pgid = os.getpgid(self.process.pid)
                    os.killpg(pgid, signal.SIGTERM)
                except Exception:
                    try:
                        self.process.terminate()
                    except:
                        pass
                try:
                    self.process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    # Force it when SIGTERM is ignored
                    try:
                        pgid = os.getpgid(self.process.pid)
                        os.killpg(pgid, signal.SIGKILL)
                    except:
                        pass
                except Exception:
                    pass
                self.process = None
            
        for q in list(self.queues):
            try:
                q.put_nowait(None)
            except Exception:
                pass
        self.queues.clear()
