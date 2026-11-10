"""Commands to the GilzaCode window, and its answers (adapted from GilzaBots' ``ide_control.py``).

The MCP tools act on the *window*: which tabs are open, what is selected, what
the PDF pane shows. The window is the only party that knows its own state, so a
command is a round trip: `IdeHub.send_command` puts it on the event stream the
window listens to (``/api/ide/events``); the window carries it out with the same
handlers a click uses (``gui/src/utils/ideCommands.js``) and posts the outcome
to ``/api/ide/result``, which resolves the pending future here.

An unanswered command fails after a short timeout with a diagnostic, instead of
pretending it took effect. With no window listening at all it fails at once.
The same stream also carries notices that need no answer (`publish`), such as
"a compile ran; refresh the PDF".
"""

from __future__ import annotations

import asyncio
import uuid

#: Seconds the window gets to carry out a command; it answers in milliseconds.
IDE_COMMAND_TIMEOUT = 15.0


class IdeCommandError(ValueError):
    """The window did not carry out a command; the message says why (it is read by the model)."""


class IdeHub:
    def __init__(self) -> None:
        self.listeners: list[asyncio.Queue] = []
        self._pending: dict[str, asyncio.Future] = {}

    def publish(self, event: dict) -> int:
        """Send `event` to every listening window; returns how many received it."""
        for queue in list(self.listeners):
            queue.put_nowait(event)
        return len(self.listeners)

    async def send_command(self, action: str, args: dict, *, project_path: str,
                           timeout: float = IDE_COMMAND_TIMEOUT) -> dict:
        """Ask the window to perform `action`; its answer, always with ``ok`` true, or `IdeCommandError`."""
        if not self.listeners:
            raise IdeCommandError("The GilzaCode window is not open, so nothing in it can be shown or read.")
        command_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self._pending[command_id] = future
        try:
            self.publish({"type": "command", "id": command_id, "action": action,
                          "args": dict(args), "project_path": project_path})
            try:
                result = await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
            except asyncio.TimeoutError:
                raise IdeCommandError(
                    f"The GilzaCode window did not answer '{action}' within {timeout:.0f} s; it may be "
                    "closed or reloading. Do not retry; tell the user what you meant to show them."
                ) from None
        finally:
            self._pending.pop(command_id, None)
            if not future.done():
                future.cancel()
        if not isinstance(result, dict):
            raise IdeCommandError(f"The GilzaCode window sent a malformed answer to '{action}'.")
        if not result.get("ok"):
            reason = str(result.get("error") or "").strip()
            raise IdeCommandError(reason or f"The GilzaCode window refused '{action}' without giving a reason.")
        return result

    def resolve(self, command_id: str, result: dict) -> bool:
        """Deliver the window's answer; False when nothing with that id is waiting."""
        future = self._pending.get(command_id)
        if future is None or future.done():
            return False
        future.set_result(result)
        return True
