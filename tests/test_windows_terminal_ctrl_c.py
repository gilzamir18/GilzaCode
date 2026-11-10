"""Ctrl+C in the integrated terminal on Windows.

ConPTY turns the ``\\x03`` xterm sends into a CTRL_C_EVENT, but PowerShell and
every command it runs ignore that event when they inherit the "ignore Ctrl+C"
console flag. Windows sets the flag on a process created with
CREATE_NEW_PROCESS_GROUP, which is how the in-app restart used to relaunch
GilzaCode, so after a restart Ctrl+C no longer stopped a running command.
"""
import subprocess
import sys
import types

from gilzacode import launcher, terminal_manager
from gilzacode.terminal_manager import TerminalSession


def test_the_restart_does_not_start_the_app_in_a_new_process_group(monkeypatch):
    captured = {}

    class _FakePopen:
        def __init__(self, command, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "Popen", _FakePopen)

    launcher.spawn_detached(["gilzacode"])

    flags = captured["creationflags"]
    assert flags & 0x00000008, "DETACHED_PROCESS keeps the relaunched app alive"
    assert not flags & 0x00000200, "CREATE_NEW_PROCESS_GROUP disables Ctrl+C for every child"


def test_the_shell_is_spawned_with_ctrl_c_enabled(monkeypatch, tmp_path):
    order = []

    class _FakePty:
        @classmethod
        def spawn(cls, shell, cwd=None, env=None):
            order.append(("spawn", shell, env))
            return object()

    managed_env = {"PATH": "C:\\GilzaCode\\bin"}
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "winpty", types.SimpleNamespace(PtyProcess=_FakePty))
    monkeypatch.setattr(
        terminal_manager, "enable_ctrl_c_for_children", lambda: order.append(("enable",))
    )
    # The shell reaches the tools GilzaCode manages (tectonic, pandoc) by PATH.
    monkeypatch.setattr(terminal_manager, "environment_with_managed_tools", lambda: managed_env)

    TerminalSession(str(tmp_path))

    assert order == [("enable",), ("spawn", "powershell.exe", managed_env)]


def test_enabling_ctrl_c_clears_the_inherited_ignore_flag(monkeypatch):
    import ctypes

    calls = []

    class _Kernel32:
        def SetConsoleCtrlHandler(self, handler, add):
            calls.append((handler, add))
            return 1

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, use_last_error=False: _Kernel32(), raising=False)

    assert terminal_manager.enable_ctrl_c_for_children() is True
    # (NULL, FALSE) is the documented call that makes a process -- and the
    # processes it creates afterwards -- honour Ctrl+C again.
    assert calls == [(None, False)]


def test_a_failure_to_enable_ctrl_c_is_reported(monkeypatch, capsys):
    import ctypes

    class _Kernel32:
        def SetConsoleCtrlHandler(self, handler, add):
            return 0

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, use_last_error=False: _Kernel32(), raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)

    assert terminal_manager.enable_ctrl_c_for_children() is False
    assert "error 5" in capsys.readouterr().out


def test_enabling_ctrl_c_is_a_no_op_outside_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    assert terminal_manager.enable_ctrl_c_for_children() is False
