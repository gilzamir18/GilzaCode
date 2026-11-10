"""The error every speech failure is reported as."""


class SpeechSynthesisError(RuntimeError):
    """Raised when audio cannot be produced.

    ``kind`` classifies the failure so the interface can say what to do:
    ``not_configured``, ``bad_request``, ``too_long``, ``empty``, ``unavailable``, ``unknown``.
    """

    def __init__(self, message: str, kind: str = "unknown") -> None:
        super().__init__(message)
        self.kind = kind
