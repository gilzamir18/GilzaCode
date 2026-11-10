"""Provider lookup.

Mirrors the shape of GilzaBots' `vcs.get_vcs_strategy`: a name-keyed table plus a
factory, so adding a backend means adding one module and one entry here.

Providers are imported lazily. A backend whose optional dependency is missing
must not stop the others from being listed or used, and the application must
start with none of them installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from .base import CloudError, CloudStorageProvider


@dataclass(frozen=True)
class ProviderInfo:
    id: str
    display_name: str
    # Whether this backend needs an interactive authorization before use.
    requires_authorization: bool
    # Set when the backend cannot be used in this installation (missing
    # dependency, unsupported platform); shown to the user instead of failing at
    # connect time with a stack trace.
    unavailable_reason: str = ""

    @property
    def available(self) -> bool:
        return not self.unavailable_reason


def _google_drive_factory(config: dict[str, Any]) -> CloudStorageProvider:
    from .providers.google_drive import GoogleDriveProvider

    return GoogleDriveProvider(
        client_id=str(config.get("client_id", "") or ""),
        client_secret=str(config.get("client_secret", "") or ""),
    )


def _local_folder_factory(config: dict[str, Any]) -> CloudStorageProvider:
    from .providers.local_folder import LocalFolderProvider

    return LocalFolderProvider(base_dir=str(config.get("base_dir", "") or ""))


_FACTORIES: dict[str, Callable[[dict[str, Any]], CloudStorageProvider]] = {
    "google_drive": _google_drive_factory,
    "local_folder": _local_folder_factory,
}

_DISPLAY_NAMES = {
    "google_drive": "Google Drive",
    "local_folder": "Local folder",
}

_REQUIRES_AUTHORIZATION = {
    "google_drive": True,
    "local_folder": False,
}


def _unavailable_reason(provider_id: str) -> str:
    if provider_id == "google_drive":
        from .providers.google_drive import unavailable_reason

        return unavailable_reason()
    return ""


def list_providers() -> list[ProviderInfo]:
    """Describe every registered backend, available or not."""
    infos: list[ProviderInfo] = []
    for provider_id in _FACTORIES:
        try:
            reason = _unavailable_reason(provider_id)
        except Exception as exc:  # a broken optional import must not hide the rest
            reason = str(exc)
        infos.append(
            ProviderInfo(
                id=provider_id,
                display_name=_DISPLAY_NAMES.get(provider_id, provider_id),
                requires_authorization=_REQUIRES_AUTHORIZATION.get(provider_id, True),
                unavailable_reason=reason,
            )
        )
    return infos


def get_cloud_provider(
    provider_id: str, config: Optional[dict[str, Any]] = None
) -> CloudStorageProvider:
    """Build a provider by id.

    Unlike `get_vcs_strategy`, an unknown id is an error rather than a silent
    fallback to a default: quietly mirroring a project to a different backend
    than the one recorded in its state would put the user's files somewhere they
    never chose.
    """
    factory = _FACTORIES.get(str(provider_id or "").strip().lower())
    if factory is None:
        known = ", ".join(sorted(_FACTORIES)) or "(none)"
        raise CloudError(f"Unknown cloud provider {provider_id!r}. Known providers: {known}")
    return factory(config or {})


def register_provider(
    provider_id: str,
    display_name: str,
    factory: Callable[[dict[str, Any]], CloudStorageProvider],
    requires_authorization: bool = True,
) -> None:
    """Add a backend at runtime. Used by tests and by out-of-tree extensions."""
    key = str(provider_id).strip().lower()
    if not key:
        raise ValueError("provider_id is required")
    _FACTORIES[key] = factory
    _DISPLAY_NAMES[key] = display_name
    _REQUIRES_AUTHORIZATION[key] = requires_authorization
