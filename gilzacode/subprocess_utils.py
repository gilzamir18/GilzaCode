"""Subprocess helpers with Unicode-safe text decoding."""

UTF8_TEXT_KWARGS = {
    "text": True,
    "encoding": "utf-8",
    "errors": "replace",
}


def utf8_text_kwargs() -> dict:
    """Return kwargs for subprocess text capture that never crashes on bytes."""
    return dict(UTF8_TEXT_KWARGS)
